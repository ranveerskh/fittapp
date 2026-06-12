import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://qusmbveovroldkhbjudq.supabase.co";
const MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const PLAN_LEVELS = {
  free: { label: "Free User", generationType: "starter" },
  premium: { label: "Premium", generationType: "premium_biweekly" },
  premium_plus: { label: "Premium Plus", generationType: "premium_plus_weekly" }
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

function siteOrigin(event) {
  const host = event.headers.host || event.headers.Host;
  const proto = event.headers["x-forwarded-proto"] || "https";
  if (host) return `${proto}://${host}`;
  return process.env.URL || process.env.DEPLOY_PRIME_URL || "";
}

function startOfCurrentMonthISO() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function cleanEntitlement(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    plan_code: row.plan_code || "free",
    plan_name: row.plan_name || row.plan_code || "Free User",
    status: row.status || "active",
    source: row.source || "free",
    starts_at: row.starts_at || null,
    ends_at: row.ends_at || null,
    features: { ...(row.plan_features || {}), ...(row.features_override || {}) }
  };
}

function planTierInfo(entitlement) {
  const code = entitlement?.plan_code || "free";
  const base = PLAN_LEVELS[code] || PLAN_LEVELS.free;
  return { code: PLAN_LEVELS[code] ? code : "free", ...base };
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

async function isAdmin(db, userId) {
  const { data, error } = await db
    .from("app_admins")
    .select("user_id, role")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return false;
  return Boolean(data?.user_id);
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
    .insert({ user_id: userId, plan_code: "free", status: "active", source: "free", starts_at: now, ends_at: null, notes: "Default free access" });
  if (error) throw error;

  await db
    .from("profiles")
    .update({ selected_plan_code: "free", onboarding_plan_selected: true, is_premium: false, updated_at: now })
    .eq("id", userId);
}

async function ensureEntitlement(db, userId) {
  await expireOldEntitlements(db, userId);
  let entitlement = await readCurrentEntitlement(db, userId);
  if (!entitlement) {
    await createFreeEntitlement(db, userId);
    entitlement = await readCurrentEntitlement(db, userId);
  }
  return entitlement || { id: null, user_id: userId, plan_code: "free", plan_name: "Free User", status: "active", source: "free", features: {} };
}

async function readUsageLimit(db, planCode) {
  const { data, error } = await db
    .from("ai_usage_limits")
    .select("*")
    .eq("plan_code", planCode)
    .maybeSingle();

  if (error || !data) {
    if (planCode === "premium_plus") return { weekly_plan_generations_per_month: 5 };
    if (planCode === "premium") return { weekly_plan_generations_per_month: 2 };
    return { weekly_plan_generations_per_month: 1 };
  }
  return data;
}

async function countMonthlyPlanGenerations(db, userId) {
  try {
    const { count, error } = await db
      .from("ai_requests")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .in("status", ["pending", "processing", "completed"])
      .gte("created_at", startOfCurrentMonthISO())
      .ilike("request_type", "weekly_plan_coach%");
    if (error) return 0;
    return count || 0;
  } catch {
    return 0;
  }
}

async function findExistingRunningRequest(db, userId) {
  const since = new Date(Date.now() - 1000 * 60 * 45).toISOString();
  const { data, error } = await db
    .from("ai_requests")
    .select("id,status,created_at,request_type")
    .eq("user_id", userId)
    .in("status", ["pending", "processing"])
    .gte("created_at", since)
    .ilike("request_type", "weekly_plan_coach%")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data || null;
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  if (event.httpMethod !== "POST") return jsonResponse(405, { ok: false, error: "Use POST from logged-in app." });

  try {
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) return jsonResponse(500, { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY missing in Netlify." });

    const db = createClient(SUPABASE_URL, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const user = await getUserFromToken(db, event);
    const userId = user.id;
    const admin = await isAdmin(db, userId);
    const entitlement = await ensureEntitlement(db, userId);
    const tier = planTierInfo(entitlement);

    const existing = await findExistingRunningRequest(db, userId);
    if (existing?.id) {
      return jsonResponse(200, {
        ok: true,
        started: true,
        already_running: true,
        request_id: existing.id,
        status: existing.status,
        needs_background_start: true,
        message: "Your AI coach is already updating your plan. It should be ready in a few minutes."
      });
    }

    const usageLimit = await readUsageLimit(db, tier.code);
    const monthlyUsed = await countMonthlyPlanGenerations(db, userId);
    const monthlyLimit = Number(usageLimit.weekly_plan_generations_per_month || 0);

    if (!admin && monthlyLimit > 0 && monthlyUsed >= monthlyLimit) {
      return jsonResponse(403, {
        ok: false,
        error: `${tier.label} plan allows ${monthlyLimit} AI plan generation${monthlyLimit === 1 ? "" : "s"} per month. You already used ${monthlyUsed}.`,
        code: "AI_LIMIT_REACHED",
        entitlement,
        usage: { monthly_used: monthlyUsed, monthly_limit: monthlyLimit }
      });
    }

    const requestInsert = await db
      .from("ai_requests")
      .insert({
        user_id: userId,
        request_type: `weekly_plan_coach_${tier.generationType}`,
        status: "pending",
        model: MODEL,
        prompt_payload: {
          entitlement,
          message: "Background generation queued",
          created_by: "generate-plan starter"
        }
      })
      .select("id")
      .single();

    if (requestInsert.error) throw requestInsert.error;
    const requestId = requestInsert.data.id;

    return jsonResponse(202, {
      ok: true,
      started: true,
      needs_background_start: true,
      request_id: requestId,
      status: "pending",
      message: "Your AI coach is updating your plan. This can take a few minutes. You can stay on this page or come back later."
    });

  } catch (error) {
    console.error(error);
    return jsonResponse(error.statusCode || 500, { ok: false, error: error.message || "Could not start AI plan update." });
  }
}
