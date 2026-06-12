import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://qusmbveovroldkhbjudq.supabase.co";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function jsonResponse(statusCode, body) {
  return { statusCode, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function getBearerToken(event) {
  const header = event.headers.authorization || event.headers.Authorization || "";
  if (!header.startsWith("Bearer ")) return "";
  return header.replace("Bearer ", "").trim();
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

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  if (event.httpMethod !== "POST") return jsonResponse(405, { ok: false, error: "Use POST from logged-in app." });

  try {
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) return jsonResponse(500, { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY missing in Netlify." });

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }
    const requestId = body.request_id || body.ai_request_id || null;
    if (!requestId) return jsonResponse(400, { ok: false, error: "request_id missing." });

    const db = createClient(SUPABASE_URL, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const user = await getUserFromToken(db, event);

    const reqRes = await db
      .from("ai_requests")
      .select("id,user_id,request_type,status,model,error_message,response_payload,input_tokens,output_tokens,created_at")
      .eq("id", requestId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (reqRes.error) throw reqRes.error;
    if (!reqRes.data) return jsonResponse(404, { ok: false, error: "AI request not found." });

    const row = reqRes.data;
    const status = row.status || "pending";
    const payload = row.response_payload || {};
    const planId = payload.plan_id || null;

    let plan = null;
    if (status === "completed" && planId) {
      const planRes = await db
        .from("weekly_plans")
        .select("id,plan_json,title,week_start,week_end,status,ai_summary,created_at")
        .eq("id", planId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (!planRes.error && planRes.data) plan = planRes.data.plan_json || null;
    }

    return jsonResponse(200, {
      ok: true,
      request_id: row.id,
      status,
      model: row.model,
      error: row.error_message || null,
      plan_id: planId,
      plan,
      input_tokens: row.input_tokens || null,
      output_tokens: row.output_tokens || null,
      message:
        status === "completed" ? "Your new plan is ready." :
        status === "failed" ? (row.error_message || "AI plan failed.") :
        "Your AI coach is updating your plan. This can take a few minutes."
    });
  } catch (error) {
    console.error(error);
    return jsonResponse(error.statusCode || 500, { ok: false, error: error.message || "Could not check AI plan status." });
  }
}
