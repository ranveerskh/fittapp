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

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function textOrNull(value, max = 1000) {
  const t = String(value || "").trim();
  if (!t) return null;
  return t.slice(0, max);
}

function bool(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function arrayFrom(value) {
  if (Array.isArray(value)) {
    return value.map(v => String(v || "").trim()).filter(Boolean).slice(0, 20);
  }
  if (!value) return [];
  return String(value)
    .split(/\n|\|/g)
    .map(v => v.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function normalizePayload(body) {
  const name = textOrNull(body.name, 120);
  if (!name) throw new Error("Exercise name is required.");

  const slug = slugify(body.slug || name);
  if (!slug) throw new Error("Exercise slug is required.");

  return {
    name,
    slug,
    category: textOrNull(body.category, 80) || "general",
    section: textOrNull(body.section, 40) || "main",
    target_muscle: textOrNull(body.target_muscle, 120),
    equipment: textOrNull(body.equipment, 120),
    difficulty: textOrNull(body.difficulty, 40) || "beginner",
    image_url: textOrNull(body.image_url, 1200),
    video_url: textOrNull(body.video_url, 1200),
    image_path: textOrNull(body.image_path, 1200),
    video_path: textOrNull(body.video_path, 1200),
    short_cue: textOrNull(body.short_cue, 500),
    common_mistake: textOrNull(body.common_mistake, 700),
    safe_alternative: textOrNull(body.safe_alternative, 700),
    pain_warning: textOrNull(body.pain_warning, 700),
    guide_steps: arrayFrom(body.guide_steps),
    common_mistakes: arrayFrom(body.common_mistakes),
    alternatives: arrayFrom(body.alternatives),
    back_safe: bool(body.back_safe),
    knee_safe: bool(body.knee_safe),
    shoulder_safe: bool(body.shoulder_safe),
    media_updated_at: new Date().toISOString()
  };
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

  return { ...exercise, image_public_url, video_public_url };
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "Use POST." });
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
    await requireAdmin(db, user.id);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return jsonResponse(400, { ok: false, error: "Invalid JSON body." });
    }

    const payload = normalizePayload(body);
    const id = textOrNull(body.id, 80);

    let saved;
    if (id) {
      const { data, error } = await db
        .from("exercises")
        .update(payload)
        .eq("id", id)
        .select("id,name,slug,category,section,target_muscle,equipment,difficulty,image_url,video_url,image_path,video_path,short_cue,common_mistake,common_mistakes,safe_alternative,alternatives,pain_warning,guide_steps,back_safe,knee_safe,shoulder_safe,media_updated_at,created_at")
        .single();
      if (error) throw error;
      saved = data;
    } else {
      const { data, error } = await db
        .from("exercises")
        .insert(payload)
        .select("id,name,slug,category,section,target_muscle,equipment,difficulty,image_url,video_url,image_path,video_path,short_cue,common_mistake,common_mistakes,safe_alternative,alternatives,pain_warning,guide_steps,back_safe,knee_safe,shoulder_safe,media_updated_at,created_at")
        .single();
      if (error) throw error;
      saved = data;
    }

    return jsonResponse(200, {
      ok: true,
      message: id ? "Exercise updated." : "Exercise created.",
      exercise: attachPublicUrls(db, saved)
    });
  } catch (error) {
    return jsonResponse(error.statusCode || 500, {
      ok: false,
      error: error.message || "Could not save exercise."
    });
  }
}
