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

function toPositiveIntOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function normalizeExpiry(value) {
  if (value === undefined) return undefined;
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
    await requireAdmin(db, user.id);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return jsonResponse(400, {
        ok: false,
        error: "Invalid JSON body."
      });
    }

    const id = String(body.id || "").trim();

    if (!id) {
      return jsonResponse(400, {
        ok: false,
        error: "Promo id is required."
      });
    }

    const updates = {
      updated_at: new Date().toISOString()
    };

    if (typeof body.is_active === "boolean") {
      updates.is_active = body.is_active;
    }

    if (body.duration_days !== undefined) {
      updates.duration_days = toPositiveIntOrNull(body.duration_days);
    }

    if (body.max_redemptions !== undefined) {
      updates.max_redemptions = toPositiveIntOrNull(body.max_redemptions);
    }

    if (body.expires_at !== undefined) {
      updates.expires_at = normalizeExpiry(body.expires_at);
    }

    if (body.notes !== undefined) {
      updates.notes = body.notes ? String(body.notes).trim() : null;
    }

    if (Object.keys(updates).length <= 1) {
      return jsonResponse(400, {
        ok: false,
        error: "No valid updates provided."
      });
    }

    const { data: promo, error } = await db
      .from("promo_codes")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    return jsonResponse(200, {
      ok: true,
      message: "Promo code updated.",
      promo
    });
  } catch (error) {
    return jsonResponse(error.statusCode || 500, {
      ok: false,
      error: error.message || "Could not update promo code."
    });
  }
}
