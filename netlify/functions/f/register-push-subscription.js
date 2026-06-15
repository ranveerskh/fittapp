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
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function bearer(event) {
  const value = event.headers.authorization || event.headers.Authorization || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

async function authenticatedUser(db, event) {
  const token = bearer(event);
  if (!token) throw Object.assign(new Error("Missing Authorization token."), { statusCode: 401 });
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) throw Object.assign(new Error("Invalid or expired session."), { statusCode: 401 });
  return data.user;
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  if (event.httpMethod !== "POST") return jsonResponse(405, { ok: false, error: "Use POST." });

  try {
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing in Netlify.");

    const db = createClient(SUPABASE_URL, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const user = await authenticatedUser(db, event);
    const body = JSON.parse(event.body || "{}");
    const subscription = body.subscription || {};
    const endpoint = String(subscription.endpoint || "").trim();
    const p256dh = String(subscription.keys?.p256dh || "").trim();
    const authSecret = String(subscription.keys?.auth || "").trim();

    if (!endpoint || !p256dh || !authSecret) {
      return jsonResponse(400, { ok: false, error: "Push subscription is incomplete." });
    }

    const now = new Date().toISOString();
    const { error } = await db
      .from("push_subscriptions")
      .upsert({
        user_id: user.id,
        endpoint,
        p256dh,
        auth_secret: authSecret,
        user_agent: String(body.user_agent || "").slice(0, 1000) || null,
        platform: String(body.platform || "").slice(0, 200) || null,
        enabled: true,
        failure_count: 0,
        last_error: null,
        last_seen_at: now,
        updated_at: now
      }, { onConflict: "endpoint" });

    if (error) throw error;

    if (body.timezone) {
      await db
        .from("notification_preferences")
        .upsert({
          user_id: user.id,
          timezone: String(body.timezone).slice(0, 120),
          updated_at: now
        }, { onConflict: "user_id" });
    }

    return jsonResponse(200, { ok: true, message: "This device is ready for ShapeCue notifications." });
  } catch (error) {
    console.error(error);
    return jsonResponse(error.statusCode || 500, { ok: false, error: error.message || "Could not save push subscription." });
  }
}
