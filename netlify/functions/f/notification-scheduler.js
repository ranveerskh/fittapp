import { createClient } from "@supabase/supabase-js";
import { sendPushToUser } from "./push-utils.js";

const SUPABASE_URL = "https://qusmbveovroldkhbjudq.supabase.co";
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function batchSize() {
  const value = Number(process.env.NOTIFICATION_BATCH_SIZE || 250);
  return Number.isFinite(value) ? Math.max(1, Math.min(Math.floor(value), 1000)) : 250;
}

function partsFor(date, timeZone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || "UTC",
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);
  }

  const get = type => parts.find(part => part.type === type)?.value || "";
  const hour = Number(get("hour") || 0);
  const minute = Number(get("minute") || 0);

  return {
    weekday: get("weekday"),
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour,
    minute,
    minutes: hour * 60 + minute
  };
}

function timeMinutes(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function dueNow(currentMinutes, scheduledMinutes, windowMinutes = 15) {
  if (scheduledMinutes === null) return false;
  const delta = (currentMinutes - scheduledMinutes + 1440) % 1440;
  return delta >= 0 && delta < windowMinutes;
}

function inQuietHours(currentMinutes, startValue, endValue) {
  const start = timeMinutes(startValue);
  const end = timeMinutes(endValue);
  if (start === null || end === null || start === end) return false;
  if (start < end) return currentMinutes >= start && currentMinutes < end;
  return currentMinutes >= start || currentMinutes < end;
}

function truncate(value, max = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function keyPart(value) {
  return String(value || "item").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "item";
}

async function sendDueReminder(db, preference, type, dueKey, payload, scheduledFor) {
  return sendPushToUser({
    db,
    userId: preference.user_id,
    type,
    preference,
    dedupeKey: `${preference.user_id}:${type}:${dueKey}`,
    payload,
    scheduledFor
  });
}

export async function handler() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return { statusCode: 500, body: "SUPABASE_SERVICE_ROLE_KEY missing." };

  const db = createClient(SUPABASE_URL, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data: preferences, error: preferenceError } = await db
    .from("notification_preferences")
    .select("*")
    .or("meal_reminders.eq.true,workout_reminders.eq.true,checkin_reminders.eq.true")
    .limit(batchSize());

  if (preferenceError) {
    console.error(preferenceError);
    return { statusCode: 500, body: preferenceError.message || "Could not load notification preferences." };
  }

  if (!preferences?.length) return { statusCode: 200, body: "No reminder preferences enabled." };

  const userIds = preferences.map(row => row.user_id);
  const { data: planRows, error: planError } = await db
    .from("weekly_plans")
    .select("user_id,plan_json,created_at")
    .in("user_id", userIds)
    .eq("status", "active")
    .order("created_at", { ascending: false });

  if (planError) {
    console.error(planError);
    return { statusCode: 500, body: planError.message || "Could not load active plans." };
  }

  const plans = new Map();
  for (const row of planRows || []) {
    if (!plans.has(row.user_id)) plans.set(row.user_id, row.plan_json || {});
  }

  const now = new Date();
  const jobs = [];

  for (const preference of preferences) {
    const local = partsFor(now, preference.timezone || "UTC");
    if (inQuietHours(local.minutes, preference.quiet_hours_start, preference.quiet_hours_end)) continue;

    const plan = plans.get(preference.user_id) || {};
    const items = Array.isArray(plan?.daily_schedule?.[local.weekday])
      ? plan.daily_schedule[local.weekday]
      : [];

    if (preference.meal_reminders) {
      items.filter(item => item?.type === "food").forEach((item, index) => {
        const itemTime = timeMinutes(item.time);
        if (itemTime === null) return;
        const due = (itemTime - Number(preference.meal_lead_minutes || 0) + 1440) % 1440;
        if (!dueNow(local.minutes, due)) return;

        const dueKey = `${local.date}:${String(due).padStart(4, "0")}:${index}:${keyPart(item.title)}`;
        jobs.push(sendDueReminder(db, preference, "meal", dueKey, {
          title: "Meal reminder",
          body: truncate(`${item.title || "Planned meal"}: ${item.text || "Open ShapeCue for your meal details."}`),
          url: "/app.html?open=today",
          tag: `meal-${local.date}-${index}`,
          data: { local_date: local.date, meal_index: index }
        }, now.toISOString()));
      });
    }

    if (preference.workout_reminders) {
      items.filter(item => item?.type === "gym").forEach((item, index) => {
        const itemTime = timeMinutes(item.time);
        if (itemTime === null) return;
        const due = (itemTime - Number(preference.workout_lead_minutes || 0) + 1440) % 1440;
        if (!dueNow(local.minutes, due)) return;

        const dueKey = `${local.date}:${String(due).padStart(4, "0")}:${index}:${keyPart(item.workout || item.title)}`;
        jobs.push(sendDueReminder(db, preference, "workout", dueKey, {
          title: "Workout reminder",
          body: truncate(`${item.title || "Today's workout"} is coming up. Open ShapeCue for the exact session.`),
          url: "/app.html?open=workout",
          tag: `workout-${local.date}`,
          data: { local_date: local.date, workout: item.workout || null }
        }, now.toISOString()));
      });
    }

    if (preference.checkin_reminders) {
      const weekdayIndex = DAY_NAMES.indexOf(local.weekday);
      const checkinTime = timeMinutes(preference.checkin_time);
      if (weekdayIndex === Number(preference.checkin_day) && dueNow(local.minutes, checkinTime)) {
        jobs.push(sendDueReminder(db, preference, "checkin", `${local.date}:${checkinTime}`, {
          title: "Weekly ShapeCue check-in",
          body: "Log your weight, measurements, pain, and notes so your next AI update has better data.",
          url: "/app.html?open=progress",
          tag: `checkin-${local.date}`,
          data: { local_date: local.date }
        }, now.toISOString()));
      }
    }
  }

  if (!jobs.length) return { statusCode: 200, body: "No reminders are due in this window." };

  const results = await Promise.allSettled(jobs);
  const sent = results.filter(item => item.status === "fulfilled" && item.value?.sent).length;
  const skipped = results.filter(item => item.status === "fulfilled" && (item.value?.skipped || item.value?.duplicate)).length;
  const failed = results.length - sent - skipped;

  console.log("ShapeCue notification scheduler", { jobs: results.length, sent, skipped, failed });
  return {
    statusCode: failed ? 207 : 200,
    body: JSON.stringify({ jobs: results.length, sent, skipped, failed })
  };
}
