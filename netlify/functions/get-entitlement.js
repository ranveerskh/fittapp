import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://qusmbveovroldkhbjudq.supabase.co";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  };
}

function getBearerToken(event) {
  const header = event.headers.authorization || event.headers.Authorization || "";
  if (!header.startsWith("Bearer ")) return "";
  return header.replace("Bearer ", "").trim();
}

async function getUserFromToken(db, event) {
  const token = getBearerToken(event);

  if (!token) {
    throw new Error("Missing Authorization Bearer token.");
  }

  const { data, error } = await db.auth.getUser(token);

  if (error || !data?.user) {
    throw new Error("Invalid or expired user token.");
  }

  return data.user;
}

function cleanEntitlement(row) {
  if (!row) return null;

  return {
    id: row.id,
    user_id: row.user_id,
    plan_code: row.plan_code,
    plan_name: row.plan_name || row.plan_code,
    status: row.status,
    source: row.source,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    features: {
      ...(row.plan_features || {}),
      ...(row.features_override || {})
    },
    monthly_price_cents: row.monthly_price_cents || 0,
    currency: row.currency || "CAD",
    is_free: row.plan_code === "free",
    is_premium: row.plan_code === "premium",
    is_premium_plus: row.plan_code === "premium_plus"
  };
}

async function expireOldEntitlements(db, userId) {
  const now = new Date().toISOString();

  await db
    .from("user_entitlements")
    .update({
      status: "expired",
      updated_at: now
    })
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
  return data || null;
}

async function createFreeEntitlement(db, userId) {
  const now = new Date().toISOString();

  const { data, error } = await db
    .from("user_entitlements")
    .insert({
      user_id: userId,
      plan_code: "free",
      status: "active",
      source: "free",
      starts_at: now,
      ends_at: null,
      notes: "Default free access"
    })
    .select()
    .single();

  if (error) throw error;

  await db
    .from("profiles")
    .update({
      selected_plan_code: "free",
      onboarding_plan_selected: true
    })
    .eq("id", userId);

  return data;
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: ""
    };
  }

  if (!["GET", "POST"].includes(event.httpMethod)) {
    return jsonResponse(405, {
      ok: false,
      error: "Use GET or POST."
    });
  }

  try {
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!serviceRoleKey) {
      return jsonResponse(500, {
        ok: false,
        error: "SUPABASE_SERVICE_ROLE_KEY missing in Netlify."
      });
    }

    const db = createClient(SUPABASE_URL, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });

    const user = await getUserFromToken(db, event);

    await expireOldEntitlements(db, user.id);

    let entitlement = await readCurrentEntitlement(db, user.id);

    if (!entitlement) {
      await createFreeEntitlement(db, user.id);
      entitlement = await readCurrentEntitlement(db, user.id);
    }

    return jsonResponse(200, {
      ok: true,
      entitlement: cleanEntitlement(entitlement)
    });

  } catch (error) {
    return jsonResponse(401, {
      ok: false,
      error: error.message || "Could not read entitlement."
    });
  }
}
