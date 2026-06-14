import webpush from "web-push";

let configured = false;

function configureWebPush() {
  if (configured) return;

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:support@example.com";

  if (!publicKey || !privateKey) {
    throw new Error("VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY is missing in Netlify.");
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
}

function preferenceField(type) {
  if (type === "meal") return "meal_reminders";
  if (type === "workout") return "workout_reminders";
  if (type === "checkin") return "checkin_reminders";
  if (type === "plan_ready") return "plan_ready_notifications";
  return null;
}

function cleanPayload(payload = {}) {
  return {
    title: String(payload.title || "ShapeCue").slice(0, 120),
    body: String(payload.body || "You have a new ShapeCue update.").slice(0, 240),
    url: String(payload.url || "/app.html"),
    tag: String(payload.tag || "shapecue").slice(0, 80),
    icon: String(payload.icon || "/favicon.ico"),
    badge: String(payload.badge || "/favicon.ico"),
    data: payload.data && typeof payload.data === "object" ? payload.data : {}
  };
}

async function reserveDelivery(db, { userId, type, dedupeKey, payload, scheduledFor }) {
  const { data, error } = await db
    .from("notification_deliveries")
    .insert({
      user_id: userId,
      notification_type: type,
      dedupe_key: dedupeKey,
      scheduled_for: scheduledFor || new Date().toISOString(),
      status: "processing",
      payload
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") return null;
    throw error;
  }

  return data;
}

async function updateSubscription(db, id, values) {
  try {
    await db.from("push_subscriptions").update(values).eq("id", id);
  } catch (error) {
    console.warn("Could not update push subscription status", error);
  }
}

export async function sendPushToUser({
  db,
  userId,
  type,
  dedupeKey,
  payload,
  scheduledFor = null,
  force = false,
  preference = null
}) {
  if (!db || !userId || !dedupeKey) {
    throw new Error("Push delivery is missing db, userId, or dedupeKey.");
  }

  const field = preferenceField(type);
  let preferences = preference;

  if (!force && field) {
    if (!preferences) {
      const { data, error } = await db
        .from("notification_preferences")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) throw error;
      preferences = data || null;
    }

    if (!preferences?.[field]) {
      return { ok: true, skipped: true, reason: "preference_disabled" };
    }
  }

  configureWebPush();
  const clean = cleanPayload(payload);
  const delivery = await reserveDelivery(db, {
    userId,
    type,
    dedupeKey,
    payload: clean,
    scheduledFor
  });

  if (!delivery) {
    return { ok: true, duplicate: true };
  }

  const { data: subscriptions, error: subscriptionError } = await db
    .from("push_subscriptions")
    .select("id,endpoint,p256dh,auth_secret,failure_count")
    .eq("user_id", userId)
    .eq("enabled", true);

  if (subscriptionError) throw subscriptionError;

  if (!subscriptions?.length) {
    await db
      .from("notification_deliveries")
      .update({ status: "skipped", error_message: "No active push subscription." })
      .eq("id", delivery.id);

    return { ok: true, skipped: true, reason: "no_subscription" };
  }

  let successCount = 0;
  const errors = [];

  await Promise.all(subscriptions.map(async subscription => {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.p256dh,
            auth: subscription.auth_secret
          }
        },
        JSON.stringify(clean),
        {
          TTL: 60 * 60,
          urgency: type === "plan_ready" ? "high" : "normal"
        }
      );

      successCount += 1;
      await updateSubscription(db, subscription.id, {
        failure_count: 0,
        last_error: null,
        last_success_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        enabled: true
      });
    } catch (error) {
      const statusCode = Number(error?.statusCode || error?.status || 0);
      const message = String(error?.body || error?.message || "Push delivery failed.").slice(0, 1800);
      errors.push(`${statusCode || "error"}: ${message}`);

      const permanent = statusCode === 404 || statusCode === 410;
      await updateSubscription(db, subscription.id, {
        enabled: permanent ? false : true,
        failure_count: Number(subscription.failure_count || 0) + 1,
        last_error: message,
        last_seen_at: new Date().toISOString()
      });
    }
  }));

  if (successCount > 0) {
    await db
      .from("notification_deliveries")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        error_message: errors.length ? errors.join(" | ").slice(0, 3000) : null
      })
      .eq("id", delivery.id);

    return { ok: true, sent: successCount, failed: errors.length };
  }

  await db.from("notification_deliveries").delete().eq("id", delivery.id);
  return {
    ok: false,
    sent: 0,
    failed: errors.length,
    error: errors.join(" | ").slice(0, 3000) || "Push delivery failed."
  };
}
