import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://qusmbveovroldkhbjudq.supabase.co";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, OPTIONS"
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
  if (!token) throw new Error("Missing Authorization Bearer token.");

  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) throw new Error("Invalid or expired user token.");
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

function attachPublicUrls(db, exercise) {
  let image_public_url = exercise.image_url || null;
  let video_public_url = exercise.video_url || null;

  if (exercise.image_path) {
    const { data } = db.storage.from("exercise-media").getPublicUrl(exercise.image_path);
    image_public_url = data?.publicUrl || image_public_url;
  }

  if (exercise.video_path) {
    const { data } = db.storage.from("exercise-media").getPublicUrl(exercise.video_path);
    video_public_url = data?.publicUrl || video_public_url;
  }

  return {
    ...exercise,
    image_public_url,
    video_public_url
  };
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { ok: false, error: "Use GET." });
  }

  try {
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) {
      return jsonResponse(500, { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY missing in Netlify." });
    }

    const db = createClient(SUPABASE_URL, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const user = await getUserFromToken(db, event);
    const admin = await requireAdmin(db, user.id);

    const { data, error } = await db
      .from("exercises")
      .select("id,name,slug,category,section,target_muscle,equipment,difficulty,image_url,video_url,image_path,video_path,short_cue,common_mistake,common_mistakes,safe_alternative,alternatives,pain_warning,guide_steps,back_safe,knee_safe,shoulder_safe,media_updated_at,created_at")
      .order("category", { ascending: true })
      .order("name", { ascending: true });

    if (error) throw error;

    return jsonResponse(200, {
      ok: true,
      admin,
      exercises: (data || []).map(row => attachPublicUrls(db, row))
    });
  } catch (error) {
    return jsonResponse(error.statusCode || 500, {
      ok: false,
      error: error.message || "Could not list exercises."
    });
  }
}
