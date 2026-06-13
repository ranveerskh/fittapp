import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://qusmbveovroldkhbjudq.supabase.co";
const MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";

function siteOrigin() {
  return String(
    process.env.URL ||
    process.env.DEPLOY_URL ||
    process.env.DEPLOY_PRIME_URL ||
    ""
  ).replace(/\/$/, "");
}

function batchSize() {
  const parsed = Number(process.env.AUTO_PLAN_BATCH_SIZE || 3);
  if (!Number.isFinite(parsed)) return 3;
  return Math.max(1, Math.min(Math.floor(parsed), 10));
}

async function dispatchBackground(origin, secret, row) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(
      `${origin}/.netlify/functions/generate-plan-background`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ShapeCue-Scheduler-Secret": secret
        },
        body: JSON.stringify({ request_id: row.request_id }),
        signal: controller.signal
      }
    );

    const body = await response.text().catch(() => "");

    if (![200, 202].includes(response.status)) {
      throw new Error(
        body || `Background dispatch failed with HTTP ${response.status}.`
      );
    }

    return {
      request_id: row.request_id,
      user_id: row.user_id,
      ok: true,
      status: response.status,
      reused_existing: Boolean(row.reused_existing)
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function handler() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const schedulerSecret = process.env.SHAPECUE_SCHEDULER_SECRET;
  const origin = siteOrigin();

  if (!serviceRoleKey) {
    console.error("SUPABASE_SERVICE_ROLE_KEY missing in Netlify.");
    return { statusCode: 500, body: "Missing service role key." };
  }

  if (!schedulerSecret || schedulerSecret.length < 24) {
    console.error("SHAPECUE_SCHEDULER_SECRET missing or too short.");
    return { statusCode: 500, body: "Missing scheduler secret." };
  }

  if (!origin) {
    console.error("Netlify site URL is unavailable.");
    return { statusCode: 500, body: "Missing site origin." };
  }

  const db = createClient(SUPABASE_URL, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data: queued, error: queueError } = await db.rpc(
    "queue_due_auto_plan_requests",
    {
      p_limit: batchSize(),
      p_model: MODEL
    }
  );

  if (queueError) {
    console.error("Could not queue due automatic AI updates:", queueError);
    return { statusCode: 500, body: queueError.message || "Queue failed." };
  }

  const rows = Array.isArray(queued) ? queued : [];

  if (!rows.length) {
    console.log("ShapeCue scheduler: no automatic AI updates are due.");
    return { statusCode: 200, body: "No updates due." };
  }

  const settled = await Promise.allSettled(
    rows.map(row => dispatchBackground(origin, schedulerSecret, row))
  );

  const results = [];

  for (let index = 0; index < settled.length; index += 1) {
    const item = settled[index];
    const row = rows[index];

    if (item.status === "fulfilled") {
      results.push(item.value);
      continue;
    }

    const message = item.reason?.message || "Background dispatch failed.";
    results.push({
      request_id: row.request_id,
      user_id: row.user_id,
      ok: false,
      error: message
    });

    await db
      .from("profiles")
      .update({
        auto_plan_update_status: "dispatch_retry",
        auto_plan_last_error: String(message).slice(0, 2000)
      })
      .eq("id", row.user_id);
  }

  const successful = results.filter(result => result.ok).length;
  const failed = results.length - successful;

  console.log("ShapeCue automatic AI scheduler result:", {
    queued: rows.length,
    successful,
    failed,
    results
  });

  return {
    statusCode: failed ? 207 : 200,
    body: JSON.stringify({ queued: rows.length, successful, failed })
  };
}
