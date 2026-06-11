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

function makeCode(prefix = "FIT") {
  const part = Math.random().toString(36).slice(2, 8).toUpperCase();
  const part2 = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}-${part}${part2}`;
}

function normalizeCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function toPositiveIntOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function normalizeExpiry(value) {
  if (!value) return null;

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;

  return d.toISOString();
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

    const { data: adminRow, error: adminError } = await db
      .from("app_admins")
      .select("user_id, role")
      .eq("user_id", user.id)
      .maybeSingle();

    if (adminError) throw adminError;

    if (!adminRow) {
      return jsonResponse(403, {
        ok: false,
        error: "Admin access required."
      });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return jsonResponse(400, {
        ok: false,
        error: "Invalid JSON body."
      });
    }

    const planCode = String(body.plan_code || "").trim();

    if (!["free", "premium", "premium_plus"].includes(planCode)) {
      return jsonResponse(400, {
        ok: false,
        error: "plan_code must be free, premium, or premium_plus."
      });
    }

    const { data: plan, error: planError } = await db
      .from("plan_catalog")
      .select("code, name")
      .eq("code", planCode)
      .maybeSingle();

    if (planError) throw planError;

    if (!plan) {
      return jsonResponse(400, {
        ok: false,
        error: "Selected plan does not exist."
      });
    }

    const code = normalizeCode(body.code) || makeCode(planCode === "premium_plus" ? "PLUS" : "PRO");
    const durationDays = toPositiveIntOrNull(body.duration_days);
    const maxRedemptions = toPositiveIntOrNull(body.max_redemptions);
    const expiresAt = normalizeExpiry(body.expires_at);

    if (!/^[A-Z0-9_-]{4,40}$/.test(code)) {
      return jsonResponse(400, {
        ok: false,
        error: "Promo code can only use A-Z, 0-9, underscore, or dash. Min 4 chars."
      });
    }

    const { data: promo, error: insertError } = await db
      .from("promo_codes")
      .insert({
        code,
        plan_code: planCode,
        duration_days: durationDays,
        max_redemptions: maxRedemptions,
        expires_at: expiresAt,
        is_active: body.is_active === false ? false : true,
        created_by: user.id,
        notes: body.notes ? String(body.notes).trim() : null
      })
      .select()
      .single();

    if (insertError) {
      if (String(insertError.message || "").toLowerCase().includes("duplicate")) {
        return jsonResponse(400, {
          ok: false,
          error: "This promo code already exists."
        });
      }

      throw insertError;
    }

    return jsonResponse(200, {
      ok: true,
      message: "Promo code created.",
      promo
    });

  } catch (error) {
    return jsonResponse(500, {
      ok: false,
      error: error.message || "Could not create promo code."
    });
  }
}
