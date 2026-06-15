-- ShapeCue Step 9: profile gate for automatic membership AI updates
-- Run this once in Supabase SQL Editor.
--
-- Important:
-- - auto-plan-scheduler.js does NOT need to be replaced.
-- - The scheduler calls this database RPC, so the safe gate belongs here.
-- - A blocked profile keeps its current plan and due date.
-- - No ai_requests row is created while waiting.
-- - No add-on credit or included membership update is consumed.
-- - The next scheduler run resumes automatically after the profile becomes current.

begin;

create or replace function public.queue_due_auto_plan_requests(
  p_limit integer default 3,
  p_model text default 'gpt-5.4-mini'
)
returns table (
  request_id uuid,
  user_id uuid,
  plan_code text,
  scheduled_for timestamptz,
  reused_existing boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile record;
  v_entitlement record;
  v_plan_code text;
  v_generation_type text;
  v_existing public.ai_requests%rowtype;
  v_existing_source text;
  v_request_id uuid;
  v_limit integer := greatest(1, least(coalesce(p_limit, 3), 20));
begin
  for v_profile in
    select
      p.id,
      p.next_plan_update_at,
      coalesce(p.profile_schema_version, 1) as profile_schema_version,
      coalesce(p.profile_update_target_version, 1) as profile_update_target_version,
      lower(coalesce(p.profile_update_status, 'current')) as profile_update_status
    from public.profiles p
    where p.onboarding_completed = true
      and p.next_plan_update_at is not null
      and p.next_plan_update_at <= now()
    order by p.next_plan_update_at asc
    for update skip locked
    limit v_limit
  loop
    -- One scheduling decision at a time for this member.
    perform pg_advisory_xact_lock(hashtextextended(v_profile.id::text, 0));

    -- ---------------------------------------------------------
    -- PROFILE UPDATE GATE
    -- ---------------------------------------------------------
    -- Explicit required/safety/in-progress states always pause a
    -- new scheduled plan. A future schema version can also turn on
    -- blocks_plan_generation without another scheduler deployment.
    --
    -- update_recommended remains non-blocking while its schema row
    -- has blocks_plan_generation = false.
    if
      v_profile.profile_update_status in (
        'update_required',
        'safety_update_required',
        'waiting_for_profile_update',
        'in_progress'
      )
      or (
        v_profile.profile_schema_version < v_profile.profile_update_target_version
        and exists (
          select 1
          from public.profile_schema_versions psv
          where psv.version = v_profile.profile_update_target_version
            and psv.is_active = true
            and psv.blocks_plan_generation = true
        )
      )
    then
      update public.profiles
      set
        auto_plan_update_status = 'waiting_for_profile_update',
        auto_plan_queued_at = null,
        auto_plan_last_error = null
      where id = v_profile.id;

      -- Keep next_plan_update_at unchanged. Once the profile is
      -- completed, this same due update is picked up automatically.
      continue;
    end if;

    select *
    into v_entitlement
    from public.current_user_entitlements cue
    where cue.user_id = v_profile.id
    order by cue.created_at desc
    limit 1;

    if v_entitlement.user_id is null then
      update public.profiles
      set auto_plan_update_status = 'not_included',
          next_plan_update_at = null,
          auto_plan_queued_at = null,
          auto_plan_last_error = null
      where id = v_profile.id;
      continue;
    end if;

    if lower(coalesce(v_entitlement.status, 'active')) not in ('active', 'trialing')
       or (v_entitlement.ends_at is not null and v_entitlement.ends_at <= now()) then
      update public.profiles
      set auto_plan_update_status = 'not_included',
          next_plan_update_at = null,
          auto_plan_queued_at = null,
          auto_plan_last_error = null
      where id = v_profile.id;
      continue;
    end if;

    v_plan_code := case
      when lower(coalesce(v_entitlement.plan_code, 'free')) in ('coach', 'premium_plus', 'premium_plus_weekly') then 'coach'
      when lower(coalesce(v_entitlement.plan_code, 'free')) in ('premium', 'premium_biweekly', 'premium_every_14_days') then 'premium'
      when lower(coalesce(v_entitlement.plan_code, 'free')) in ('plus', 'premium_monthly', 'plus_monthly') then 'plus'
      else 'free'
    end;

    if v_plan_code = 'free' then
      update public.profiles
      set auto_plan_update_status = 'not_included',
          next_plan_update_at = null,
          auto_plan_queued_at = null,
          auto_plan_last_error = null
      where id = v_profile.id;
      continue;
    end if;

    -- Automatic updates begin only after the member generated a first AI plan.
    if not exists (
      select 1
      from public.weekly_plans wp
      where wp.user_id = v_profile.id
        and lower(coalesce(wp.generated_by, '')) = 'ai'
    ) then
      update public.profiles
      set auto_plan_update_status = 'waiting_for_first_plan',
          next_plan_update_at = null,
          auto_plan_queued_at = null,
          auto_plan_last_error = null
      where id = v_profile.id;
      continue;
    end if;

    -- Re-dispatch an existing scheduled request instead of inserting another.
    select *
    into v_existing
    from public.ai_requests ar
    where ar.user_id = v_profile.id
      and ar.status in ('pending', 'processing')
      and ar.request_type ilike 'weekly_plan_coach%'
    order by ar.created_at desc
    limit 1;

    if v_existing.id is not null then
      v_existing_source := coalesce(v_existing.prompt_payload #>> '{access,request_source}', '');

      if v_existing_source = 'scheduled_auto' then
        update public.profiles
        set auto_plan_update_status = case when v_existing.status = 'processing' then 'processing' else 'queued' end,
            auto_plan_queued_at = coalesce(auto_plan_queued_at, v_existing.created_at),
            auto_plan_last_error = null
        where id = v_profile.id;

        request_id := v_existing.id;
        user_id := v_profile.id;
        plan_code := v_plan_code;
        scheduled_for := v_profile.next_plan_update_at;
        reused_existing := true;
        return next;
      end if;

      -- A first-plan, admin, or add-on request is already running.
      -- Keep the membership update due and try again on the next scheduler run.
      update public.profiles
      set auto_plan_update_status = 'waiting_for_current_update'
      where id = v_profile.id;
      continue;
    end if;

    v_generation_type := case
      when v_plan_code = 'coach' then 'coach_weekly'
      when v_plan_code = 'premium' then 'premium_every_14_days'
      else 'plus_monthly'
    end;

    insert into public.ai_requests (
      user_id,
      request_type,
      status,
      model,
      prompt_payload
    )
    values (
      v_profile.id,
      'weekly_plan_coach_scheduled_' || v_generation_type,
      'pending',
      coalesce(nullif(trim(p_model), ''), 'gpt-5.4-mini'),
      jsonb_build_object(
        'access', jsonb_build_object(
          'request_source', 'scheduled_auto',
          'authorized_by', 'membership_schedule',
          'credit_consumed', false,
          'credit_refunded', false,
          'authorized_at', now()
        ),
        'schedule', jsonb_build_object(
          'scheduled_for', v_profile.next_plan_update_at,
          'queued_at', now(),
          'plan_code', v_plan_code
        ),
        'profile_gate', jsonb_build_object(
          'profile_schema_version', v_profile.profile_schema_version,
          'profile_update_target_version', v_profile.profile_update_target_version,
          'profile_update_status', v_profile.profile_update_status,
          'passed_at', now()
        ),
        'created_by', 'auto-plan-scheduler'
      )
    )
    returning id into v_request_id;

    update public.profiles
    set auto_plan_update_status = 'queued',
        auto_plan_queued_at = now(),
        auto_plan_last_error = null
    where id = v_profile.id;

    request_id := v_request_id;
    user_id := v_profile.id;
    plan_code := v_plan_code;
    scheduled_for := v_profile.next_plan_update_at;
    reused_existing := false;
    return next;
  end loop;
end;
$$;

revoke all on function public.queue_due_auto_plan_requests(integer, text) from public;
revoke all on function public.queue_due_auto_plan_requests(integer, text) from anon;
revoke all on function public.queue_due_auto_plan_requests(integer, text) from authenticated;
grant execute on function public.queue_due_auto_plan_requests(integer, text) to service_role;

commit;

-- Verification: this does not trigger or consume an update.
select
  count(*) as profiles_tracked,
  count(*) filter (
    where profile_update_status in (
      'update_required',
      'safety_update_required',
      'waiting_for_profile_update',
      'in_progress'
    )
  ) as profiles_that_would_wait,
  count(*) filter (
    where profile_update_status = 'current'
      and profile_schema_version >= profile_update_target_version
  ) as profiles_current,
  count(*) filter (
    where auto_plan_update_status = 'waiting_for_profile_update'
  ) as currently_waiting_for_profile
from public.profiles;
