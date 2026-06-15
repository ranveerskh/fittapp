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

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  if (event.httpMethod !== "POST") return jsonResponse(405, { ok: false, error: "Use POST." });

  try {
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing in Netlify.");

    const db = createClient(SUPABASE_URL, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const token = bearer(event);
    const { data, error: userError } = await db.auth.getUser(token);
    if (userError || !data?.user) {
      return jsonResponse(401, { ok: false, error: "Invalid or expired session." });
    }

    const body = JSON.parse(event.body || "{}");
    const endpoint = String(body.endpoint || "").trim();
    if (!endpoint) return jsonResponse(400, { ok: false, error: "endpoint missing." });

    const { error } = await db
      .from("push_subscriptions")
      .delete()
      .eq("user_id", data.user.id)
      .eq("endpoint", endpoint);

    if (error) throw error;
    return jsonResponse(200, { ok: true });
  } catch (error) {
    console.error(error);
    return jsonResponse(error.statusCode || 500, { ok: false, error: error.message || "Could not remove push subscription." });
  }
}
