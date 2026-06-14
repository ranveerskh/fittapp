import { createClient } from "@supabase/supabase-js";
import { sendPushToUser } from "./push-utils.js";

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

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  if (event.httpMethod !== "POST") return jsonResponse(405, { ok: false, error: "Use POST." });

  try {
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing in Netlify.");

    const db = createClient(SUPABASE_URL, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const { data, error } = await db.auth.getUser(bearer(event));
    if (error || !data?.user) return jsonResponse(401, { ok: false, error: "Invalid or expired session." });

    const result = await sendPushToUser({
      db,
      userId: data.user.id,
      type: "test",
      force: true,
      dedupeKey: `test:${data.user.id}:${Date.now()}`,
      payload: {
        title: "ShapeCue notifications are working",
        body: "Meal, workout, check-in, and AI plan-ready reminders can now reach this device.",
        url: "/settings.html",
        tag: "shapecue-test"
      }
    });

    if (!result.ok || result.skipped) {
      return jsonResponse(409, { ok: false, error: result.error || "No active notification subscription was found." });
    }

    return jsonResponse(200, { ok: true, result });
  } catch (error) {
    console.error(error);
    return jsonResponse(error.statusCode || 500, { ok: false, error: error.message || "Could not send test notification." });
  }
}
