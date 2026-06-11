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

function cleanPath(value) {
  const path = String(value || "").trim().replace(/^\/+/, "");

  if (!path) throw new Error("Upload path is required.");
  if (path.includes("..")) throw new Error("Invalid upload path.");
  if (path.length > 240) throw new Error("Upload path is too long.");
  if (!/^[a-zA-Z0-9/_.,()\-]+$/.test(path)) {
    throw new Error("Upload path contains unsupported characters.");
  }

  return path;
}

function validateMedia({ bucket, path, mime_type, size }) {
  if (bucket !== "exercise-media") {
    throw new Error("Only exercise-media uploads are allowed here.");
  }

  const allowedTypes = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "video/mp4",
    "video/webm",
    "video/quicktime"
  ]);

  const mime = String(mime_type || "").trim().toLowerCase();
  if (!allowedTypes.has(mime)) {
    throw new Error("Unsupported file type. Use JPG, PNG, WEBP, GIF, MP4, WEBM, or MOV.");
  }

  const n = Number(size || 0);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("Invalid file size.");
  }

  if (n > 52428800) {
    throw new Error("File too large. Exercise media limit is 50 MB.");
  }

  const lower = path.toLowerCase();
  const okExt = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".webm", ".mov"].some(ext => lower.endsWith(ext));
  if (!okExt) {
    throw new Error("File extension is not allowed.");
  }
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

    const bucket = String(body.bucket || "exercise-media").trim();
    const path = cleanPath(body.path);
    const mime_type = String(body.mime_type || "").trim();
    const size = Number(body.size || 0);

    validateMedia({ bucket, path, mime_type, size });

    const { data, error } = await db.storage
      .from(bucket)
      .createSignedUploadUrl(path);

    if (error) throw error;

    return jsonResponse(200, {
      ok: true,
      bucket,
      path: data.path || path,
      token: data.token,
      signedUrl: data.signedUrl
    });
  } catch (error) {
    return jsonResponse(error.statusCode || 500, {
      ok: false,
      error: error.message || "Could not create upload URL."
    });
  }
}
