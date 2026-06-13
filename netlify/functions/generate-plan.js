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

function rpcErrorToHttp(error) {
  const message = String(error?.message || error || "Could not authorize AI update.");
  const upper = message.toUpperCase();

  if (upper.includes("NO_EXTRA_AI_UPDATES")) {
    return { statusCode: 403, code: "NO_EXTRA_AI_UPDATES", message: "No extra AI update add-ons remain." };
  }
  if (upper.includes("ADMIN_REQUIRED")) {
    return { statusCode: 403, code: "ADMIN_REQUIRED", message: "Only an app admin can use the admin manual update." };
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
    if (!["admin_manual", "addon_credit"].includes(requestSource)) {
      return jsonResponse(403, {
        ok: false,
        code: "MANUAL_UPDATE_NOT_ALLOWED",
        error: "Subscription updates run automatically. A manual update requires admin access or a purchased extra AI update."
      });
    }

    const db = createClient(SUPABASE_URL, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const user = await getUserFromToken(db, event);
    const entitlement = await ensureEntitlement(db, user.id);
    const tier = planTierInfo(entitlement);
    const requestType = `weekly_plan_coach_${tier.generationType}`;

    const { data: started, error: startError } = await db.rpc("start_manual_ai_plan_request", {
      p_user_id: user.id,
      p_request_source: requestSource,
      p_request_type: requestType,
      p_model: MODEL,
      p_prompt_payload: {
        entitlement,
        created_by: "generate-plan",
        queued_at: new Date().toISOString()
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
