import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://qusmbveovroldkhbjudq.supabase.co";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
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

function normalizeCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function addDays(days) {
  if (!days) return null;
  const d = new Date();
  d.setDate(d.getDate() + Number(days));
  return d.toISOString();
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

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: ""
    };
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, {
      ok: false,
      error: "Use POST."
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

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return jsonResponse(400, {
        ok: false,
        error: "Invalid JSON body."
      });
    }

    const code = normalizeCode(body.code);

    if (!code) {
      return jsonResponse(400, {
        ok: false,
        error: "Enter a promo code."
      });
    }

    const { data: promo, error: promoError } = await db
      .from("promo_codes")
      .select("*")
      .eq("code", code)
      .maybeSingle();

    if (promoError) throw promoError;

    if (!promo) {
      return jsonResponse(404, {
        ok: false,
        error: "Promo code not found."
      });
    }

    if (!promo.is_active) {
      return jsonResponse(400, {
        ok: false,
        error: "This promo code is not active."
      });
    }

    if (promo.expires_at && new Date(promo.expires_at).getTime() < Date.now()) {
      return jsonResponse(400, {
        ok: false,
        error: "This promo code has expired."
      });
    }

    if (
      promo.max_redemptions !== null &&
      promo.max_redemptions !== undefined &&
      Number(promo.used_count || 0) >= Number(promo.max_redemptions)
    ) {
      return jsonResponse(400, {
        ok: false,
        error: "This promo code has reached its usage limit."
      });
    }

    const { data: alreadyUsed, error: usedError } = await db
      .from("promo_redemptions")
      .select("id")
      .eq("promo_code_id", promo.id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (usedError) throw usedError;

    if (alreadyUsed) {
      return jsonResponse(400, {
        ok: false,
        error: "You already used this promo code."
      });
    }

    const now = new Date().toISOString();
    const endsAt = addDays(promo.duration_days);

    const { data: entitlement, error: entitlementError } = await db
      .from("user_entitlements")
      .insert({
        user_id: user.id,
        plan_code: promo.plan_code,
        status: "active",
        source: "promo_code",
        starts_at: now,
        ends_at: endsAt,
        promo_code_id: promo.id,
        notes: `Redeemed promo code ${promo.code}`
      })
      .select()
      .single();

    if (entitlementError) throw entitlementError;

    const { error: redemptionError } = await db
      .from("promo_redemptions")
      .insert({
        promo_code_id: promo.id,
        user_id: user.id,
        entitlement_id: entitlement.id
      });

    if (redemptionError) {
      await db
        .from("user_entitlements")
        .update({
          status: "cancelled",
          updated_at: now
        })
        .eq("id", entitlement.id);

      throw redemptionError;
    }

    await db
      .from("promo_codes")
      .update({
        used_count: Number(promo.used_count || 0) + 1,
        updated_at: now
      })
      .eq("id", promo.id);

    await db
      .from("user_entitlements")
      .update({
        status: "cancelled",
        updated_at: now
      })
      .eq("user_id", user.id)
      .in("status", ["active", "trialing"])
      .neq("id", entitlement.id);

    await db
      .from("profiles")
      .update({
        selected_plan_code: promo.plan_code,
        onboarding_plan_selected: true
      })
      .eq("id", user.id);

    const current = await readCurrentEntitlement(db, user.id);

    return jsonResponse(200, {
      ok: true,
      message: `${promo.plan_code === "premium_plus" ? "Premium Plus" : "Premium"} unlocked.`,
      entitlement: cleanEntitlement(current)
    });

  } catch (error) {
    return jsonResponse(500, {
      ok: false,
      error: error.message || "Could not redeem promo code."
    });
  }
}
