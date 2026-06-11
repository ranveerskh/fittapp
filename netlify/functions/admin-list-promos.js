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

async function requireAdmin(db, userId) {
  const { data, error } = await db
    .from("app_admins")
    .select("user_id, role")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    const err = new Error("Admin access required.");
    err.statusCode = 403;
    throw err;
  }

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
    const admin = await requireAdmin(db, user.id);

    const { data: promos, error: promoError } = await db
      .from("promo_codes")
      .select("id, code, plan_code, duration_days, max_redemptions, used_count, expires_at, is_active, notes, created_at, updated_at, created_by")
      .order("created_at", { ascending: false })
      .limit(200);

    if (promoError) throw promoError;

    const { data: plans, error: planError } = await db
      .from("plan_catalog")
      .select("code, name, monthly_price_cents, currency");

    if (planError) throw planError;

    const planMap = new Map((plans || []).map(plan => [plan.code, plan]));

    const decorated = (promos || []).map(promo => {
      const plan = planMap.get(promo.plan_code) || {};
      return {
        ...promo,
        plan_name: plan.name || promo.plan_code,
        monthly_price_cents: plan.monthly_price_cents || 0,
        currency: plan.currency || "CAD"
      };
    });

    return jsonResponse(200, {
      ok: true,
      admin,
      promos: decorated
    });
  } catch (error) {
    return jsonResponse(error.statusCode || 500, {
      ok: false,
      error: error.message || "Could not list promo codes."
    });
  }
}
