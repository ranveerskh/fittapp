import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://qusmbveovroldkhbjudq.supabase.co";
const MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const PLAN_LEVELS = {
  free: { label: "Free", generationType: "starter" },
  plus: { label: "Plus", generationType: "plus_monthly" },
  premium: { label: "Premium", generationType: "premium_every_14_days" },
  coach: { label: "Coach", generationType: "coach_weekly" }
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function getBearerToken(event) {
  const header = event.headers.authorization || event.headers.Authorization || "";
  if (!header.startsWith("Bearer ")) return "";
  return header.replace("Bearer ", "").trim();
}

function normalizePlanCode(code) {
  const value = String(code || "free").toLowerCase();
  if (["coach", "premium_plus", "premium_plus_weekly"].includes(value)) return "coach";
  if (["premium", "premium_biweekly", "premium_every_14_days"].includes(value)) return "premium";
  if (["plus", "premium_monthly", "plus_monthly"].includes(value)) return "plus";
  return "free";
}

function cleanEntitlement(row) {
  if (!row) return null;
  const planCode = normalizePlanCode(row.plan_code);
  return {
    id: row.id,
    user_id: row.user_id,
    plan_code: planCode,
    plan_name: row.plan_name || PLAN_LEVELS[planCode]?.label || "Free",
    status: row.status || "active",
    source: row.source || "free",
    starts_at: row.starts_at || null,
    ends_at: row.ends_at || null,
    features: { ...(row.plan_features || {}), ...(row.features_override || {}) }
  };
}

function planTierInfo(entitlement) {
  const code = normalizePlanCode(entitlement?.plan_code);
  return { code, ...(PLAN_LEVELS[code] || PLAN_LEVELS.free) };
}

async function getUserFromToken(db, event) {
  const token = getBearerToken(event);
  if (!token) {
    const err = new Error("Missing Authorization Bearer token.");
    err.statusCode = 401;
    throw err;
  }

  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) {
    const err = new Error("Invalid or expired user token.");
    err.statusCode = 401;
    throw err;
  }
  return data.user;
}

async function expireOldEntitlements(db, userId) {
  const now = new Date().toISOString();
  await db
    .from("user_entitlements")
    .update({ status: "expired", updated_at: now })
    .eq("user_id", userId)
    .in("status", ["active", "trialing"])
    .not("ends_at", "is", null)
    .lt("ends_at", now);
}

async function readCurrentEntitlement(db, userId) {
  const { data, error } = await db
    .from("current_user_entitlements")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return cleanEntitlement(data);
}

async function createFreeEntitlement(db, userId) {
  const now = new Date().toISOString();
  const { error } = await db
    .from("user_entitlements")
    .insert({
      user_id: userId,
      plan_code: "free",
      status: "active",
      source: "free",
      starts_at: now,
      ends_at: null,
      notes: "Default free access"
    });

  if (error) throw error;

  await db
    .from("profiles")
    .update({
      selected_plan_code: "free",
      onboarding_plan_selected: true,
      is_premium: false,
      updated_at: now
    })
    .eq("id", userId);
}

async function ensureEntitlement(db, userId) {
  await expireOldEntitlements(db, userId);
  let entitlement = await readCurrentEntitlement(db, userId);

  if (!entitlement) {
    await createFreeEntitlement(db, userId);
    entitlement = await readCurrentEntitlement(db, userId);
  }

  return entitlement || {
    id: null,
    user_id: userId,
    plan_code: "free",
    plan_name: "Free",
    status: "active",
    source: "free",
    features: {}
  };
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function hasArray(value) {
  return Array.isArray(value) && value.some(item => hasValue(item));
}

function validateFirstPlanSetup(setup) {
  const profile = setup.profile || {};
  const structuredGoal = setup.structuredGoal || {};
  const lifeStage = setup.lifeStage || {};
  const workout = setup.workout || {};
  const work = setup.work || {};
  const food = setup.food || {};
  const water = setup.water || {};
  const latestMeasurement = setup.latestMeasurement || {};
  const missing = [];

  const add = (section, label, ready) => {
    if (!ready) missing.push(`${section}: ${label}`);
  };

  add("Personal information", "full name", hasValue(profile.full_name));
  add("Personal information", "date of birth", hasValue(profile.date_of_birth));
  add("Personal information", "gender", hasValue(profile.gender));
  add("Personal information", "height", Number(profile.height_cm) > 0);
  add("Personal information", "current weight", Number(profile.starting_weight || latestMeasurement.weight) > 0);
  add("Profile update", "profile version 2", Number(profile.profile_schema_version || 1) >= 2);

  add("Goals and body", "main result", hasValue(structuredGoal.primary_goal));
  add("Goals and body", "desired physique", hasValue(structuredGoal.physique_preference));
  add("Goals and body", "at least one body-focus area", hasArray(structuredGoal.focus_areas));
  add("Goals and body", "at least one fitness ability", hasArray(structuredGoal.fitness_priorities));
  add("Goals and body", "current starting point", hasValue(profile.body_type));

  const purpose = String(structuredGoal.activity_purpose || "").toLowerCase();
  if (purpose === "sports_performance") {
    add("Goals and body", "sport or activity", hasValue(structuredGoal.sport_or_activity));
  }

  add("Life stage and safety", "pregnancy or postpartum selection", hasValue(lifeStage.life_stage));
  const stage = String(lifeStage.life_stage || "").toLowerCase();

  if (purpose === "pregnancy_fitness") {
    add("Life stage and safety", "pregnancy status", ["planning_pregnancy", "pregnant"].includes(stage));
  }

  if (purpose === "postpartum_recovery") {
    add("Life stage and safety", "postpartum status", stage === "postpartum");
  }

  if (stage === "pregnant") {
    add(
      "Life stage and safety",
      "pregnancy week",
      Number(lifeStage.pregnancy_week) >= 1 && Number(lifeStage.pregnancy_week) <= 42
    );
  }

  if (stage === "postpartum") {
    add("Life stage and safety", "delivery date", hasValue(lifeStage.delivery_date));
  }

  if (["pregnant", "postpartum"].includes(stage)) {
    const clearance = String(lifeStage.exercise_clearance || "").toLowerCase();
    add(
      "Life stage and safety",
      "exercise clearance allowing training",
      ["cleared", "cleared_with_restrictions"].includes(clearance)
    );

    if (clearance === "cleared_with_restrictions") {
      add(
        "Life stage and safety",
        "clearance restrictions",
        hasValue(lifeStage.restrictions_or_complications)
      );
    }
  }

  add("Workout setup", "workout place", hasValue(workout.workout_place));
  add("Workout setup", "workout days", hasArray(workout.workout_days));
  add("Workout setup", "time available", Number(workout.max_minutes) > 0);
  add("Workout setup", "training experience", hasValue(workout.experience_level));
  add("Workout setup", "training split", hasValue(workout.preferred_split));
  add("Workout setup", "equipment preference", hasArray(workout.equipment));

  add("Pain and safety", "pain or no-pain selection", hasArray(workout.pain_areas));
  add("Pain and safety", "pain rating", hasValue(workout.pain_rating));

  const notWorking = ["not_working", "retired", "student_no_job"].includes(
    String(work.job_activity || "").toLowerCase()
  );

  if (!notWorking) {
    add("Work schedule", "work days", hasArray(work.work_days));
    add("Work schedule", "work start time", hasValue(work.work_start));
    add("Work schedule", "work end time", hasValue(work.work_end));
    add("Work schedule", "job activity", hasValue(work.job_activity));
    add("Work schedule", "at least one break or eating window", hasArray(work.breaks));
  }

  add("Food setup", "diet type", hasValue(food.diet_type));
  add("Food setup", "cuisine preference", hasArray(food.food_styles) || hasValue(food.food_style));
  add("Food setup", "protein preferences", hasArray(food.preferred_proteins));
  add("Food setup", "carb preferences", hasArray(food.preferred_carbs));
  add("Food setup", "allergy or no-allergy selection", hasArray(food.allergies));
  add("Food setup", "smoothie preference", typeof food.likes_smoothies === "boolean");
  add("Food setup", "whey preference", typeof food.uses_whey_protein === "boolean");
  add("Food setup", "usual or favourite foods", hasValue(food.usual_foods) || hasValue(food.favourite_foods));
  add("Food setup", "meal prep style", hasValue(food.meal_prep_style));

  add("Water setup", "bottle size", Number(water.bottle_size_ml) > 0);
  add("Water setup", "daily water target", Number(water.daily_target_liters || water.target_liters) > 0);

  return { complete: missing.length === 0, missing };
}

async function readFirstPlanSetup(db, userId) {
  const [profileRes, structuredGoalRes, lifeStageRes, workoutRes, workRes, foodRes, waterRes, measurementRes] = await Promise.all([
    db.from("profiles").select("*").eq("id", userId).maybeSingle(),
    db.from("fitness_goal_profiles").select("*").eq("user_id", userId).maybeSingle(),
    db.from("user_life_stage_profiles").select("*").eq("user_id", userId).maybeSingle(),
    db.from("workout_availability").select("*").eq("user_id", userId).maybeSingle(),
    db.from("work_schedules").select("*").eq("user_id", userId).maybeSingle(),
    db.from("food_preferences").select("*").eq("user_id", userId).maybeSingle(),
    db.from("water_settings").select("*").eq("user_id", userId).maybeSingle(),
    db.from("measurements").select("weight").eq("user_id", userId).order("entry_date", { ascending: false }).limit(1)
  ]);

  const firstError = [
    profileRes.error,
    structuredGoalRes.error,
    lifeStageRes.error,
    workoutRes.error,
    workRes.error,
    foodRes.error,
    waterRes.error,
    measurementRes.error
  ].find(Boolean);

  if (firstError) throw firstError;

  return {
    profile: profileRes.data || {},
    structuredGoal: structuredGoalRes.data || {},
    lifeStage: lifeStageRes.data || {},
    workout: workoutRes.data || {},
    work: workRes.data || {},
    food: foodRes.data || {},
    water: waterRes.data || {},
    latestMeasurement: measurementRes.data?.[0] || {}
  };
}

function rpcErrorToHttp(error) {
  const message = String(error?.message || error || "Could not authorize AI update.");
  const upper = message.toUpperCase();

  if (upper.includes("NO_EXTRA_AI_UPDATES")) {
    return { statusCode: 403, code: "NO_EXTRA_AI_UPDATES", message: "No extra AI update add-ons remain." };
  }
  if (upper.includes("ADMIN_REQUIRED")) {
    return { statusCode: 403, code: "ADMIN_REQUIRED", message: "Only an app admin can use the admin manual update." };
  }
  if (upper.includes("FIRST_PLAN_ALREADY_EXISTS")) {
    return { statusCode: 409, code: "FIRST_PLAN_ALREADY_EXISTS", message: "The free first-plan action has already been used." };
  }
  if (upper.includes("INVALID_REQUEST_SOURCE")) {
    return { statusCode: 400, code: "INVALID_REQUEST_SOURCE", message: "Invalid AI update request source." };
  }
  return { statusCode: 500, code: "AI_REQUEST_START_FAILED", message };
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "Use POST from the logged-in app." });
  }

  try {
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) {
      return jsonResponse(500, { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY missing in Netlify." });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      body = {};
    }

    const requestSource = String(body.request_source || "").trim().toLowerCase();
    if (!["first_plan", "admin_manual", "addon_credit"].includes(requestSource)) {
      return jsonResponse(403, {
        ok: false,
        code: "MANUAL_UPDATE_NOT_ALLOWED",
        error: "A plan request must be the one-time first plan, an admin update, or a purchased extra AI update."
      });
    }

    const db = createClient(SUPABASE_URL, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const user = await getUserFromToken(db, event);
    const entitlement = await ensureEntitlement(db, user.id);
    const tier = planTierInfo(entitlement);
    let firstPlanSetup = null;

    if (requestSource === "first_plan") {
      firstPlanSetup = await readFirstPlanSetup(db, user.id);
      const setupStatus = validateFirstPlanSetup(firstPlanSetup);

      if (!setupStatus.complete) {
        return jsonResponse(422, {
          ok: false,
          code: "SETUP_INCOMPLETE",
          error: "Complete the required setup details before generating the first AI plan.",
          missing_setup: setupStatus.missing
        });
      }
    }

    const requestType = requestSource === "first_plan"
      ? `weekly_plan_coach_first_${tier.generationType}`
      : `weekly_plan_coach_${tier.generationType}`;

    const { data: started, error: startError } = await db.rpc("start_manual_ai_plan_request", {
      p_user_id: user.id,
      p_request_source: requestSource,
      p_request_type: requestType,
      p_model: MODEL,
      p_prompt_payload: {
        entitlement,
        created_by: "generate-plan",
        queued_at: new Date().toISOString(),
        first_plan: requestSource === "first_plan",
        profile_schema_version: firstPlanSetup?.profile?.profile_schema_version || null,
        structured_goal: firstPlanSetup ? {
          primary_goal: firstPlanSetup.structuredGoal?.primary_goal || null,
          physique_preference: firstPlanSetup.structuredGoal?.physique_preference || null,
          focus_areas: firstPlanSetup.structuredGoal?.focus_areas || [],
          fitness_priorities: firstPlanSetup.structuredGoal?.fitness_priorities || [],
          activity_purpose: firstPlanSetup.structuredGoal?.activity_purpose || null,
          sport_or_activity: firstPlanSetup.structuredGoal?.sport_or_activity || null,
          custom_goal: firstPlanSetup.structuredGoal?.custom_goal || null
        } : null,
        life_stage: firstPlanSetup ? {
          life_stage: firstPlanSetup.lifeStage?.life_stage || null,
          pregnancy_week: firstPlanSetup.lifeStage?.pregnancy_week || null,
          delivery_date: firstPlanSetup.lifeStage?.delivery_date || null,
          delivery_type: firstPlanSetup.lifeStage?.delivery_type || null,
          breastfeeding_status: firstPlanSetup.lifeStage?.breastfeeding_status || null,
          exercise_clearance: firstPlanSetup.lifeStage?.exercise_clearance || null,
          restrictions_or_complications: firstPlanSetup.lifeStage?.restrictions_or_complications || null,
          pelvic_floor_symptoms: firstPlanSetup.lifeStage?.pelvic_floor_symptoms || [],
          diastasis_status: firstPlanSetup.lifeStage?.diastasis_status || null,
          incision_or_pelvic_pain: firstPlanSetup.lifeStage?.incision_or_pelvic_pain ?? null,
          recovery_notes: firstPlanSetup.lifeStage?.recovery_notes || null
        } : null
      }
    });

    if (startError) {
      const mapped = rpcErrorToHttp(startError);
      return jsonResponse(mapped.statusCode, {
        ok: false,
        code: mapped.code,
        error: mapped.message
      });
    }

    const result = started || {};
    const alreadyRunning = Boolean(result.already_running);

    return jsonResponse(alreadyRunning ? 200 : 202, {
      ok: true,
      started: true,
      already_running: alreadyRunning,
      needs_background_start: true,
      request_id: result.request_id,
      request_source: result.request_source || requestSource,
      status: result.status || "pending",
      extra_updates_remaining: Number(result.extra_updates_remaining || 0),
      entitlement,
      message: alreadyRunning
        ? "Your AI coach is already updating your plan."
        : requestSource === "first_plan"
          ? "Your first AI plan is now being prepared. No add-on credit was used."
          : requestSource === "addon_credit"
            ? "One extra AI update was reserved. Your AI coach is now updating the plan."
            : "Admin AI plan update started."
    });
  } catch (error) {
    console.error(error);
    return jsonResponse(error.statusCode || 500, {
      ok: false,
      error: error.message || "Could not start AI plan update."
    });
  }
}
