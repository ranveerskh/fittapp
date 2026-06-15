import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://qusmbveovroldkhbjudq.supabase.co";
const MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const PLAN_LEVELS = {
  free: {
    label: "Free",
    generationType: "starter",
    isPremium: false,
    maxOutputTokens: 10000,
    instruction: `
FREE PLAN:
- Create a safe and useful 7-day starter plan.
- Keep meal replacements and coaching detail basic.
- The user sees the Today experience, while paid-only UI features stay locked.
`
  },
  plus: {
    label: "Plus",
    generationType: "plus_monthly",
    isPremium: true,
    maxOutputTokens: 14000,
    instruction: `
PLUS PLAN:
- Create a practical full 7-day plan.
- Include workday, gym-day, and off-day meal timing.
- Include exact foods, protein estimates, meal-prep notes, replacements, and safe workout guidance.
- This plan is automatically refreshed monthly by the membership scheduler.
`
  },
  premium: {
    label: "Premium",
    generationType: "premium_every_14_days",
    isPremium: true,
    maxOutputTokens: 17000,
    instruction: `
PREMIUM PLAN:
- Create a detailed full 7-day plan.
- Include grocery planning, meal preparation, progression-aware workouts, smart replacements, and pain-aware adjustments.
- This plan is automatically refreshed every 14 days by the membership scheduler.
`
  },
  coach: {
    label: "Coach",
    generationType: "coach_weekly",
    isPremium: true,
    maxOutputTokens: 20000,
    instruction: `
COACH PLAN:
- Create the strongest weekly coaching plan.
- Include coach reasoning, smart replacements, progress-based changes, safety flags, and clear explanations of why the plan changed.
- Use recent logs and previous plans heavily.
- This plan is automatically refreshed weekly by the membership scheduler.
`
  }
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function getBearerToken(event) {
  const header = event.headers.authorization || event.headers.Authorization || "";
  if (!header.startsWith("Bearer ")) return "";
  return header.replace("Bearer ", "").trim();
}

function normalizePlanCode(code) {
  const value = String(code || "free").toLowerCase();
  if (["coach", "premium_plus", "premium_plus_weekly"].includes(value)) return "coach";
  if (["premium", "premium_biweekly", "premium_every_14_days"].includes(value)) return "premium";
  if (["plus", "premium_monthly", "plus_monthly"].includes(value)) return "plus";
  return "free";
}

function planTierInfo(entitlement) {
  const code = normalizePlanCode(entitlement?.plan_code);
  return { code, ...(PLAN_LEVELS[code] || PLAN_LEVELS.free) };
}

function cleanEntitlement(row) {
  if (!row) return null;
  const planCode = normalizePlanCode(row.plan_code);
  return {
    id: row.id,
    user_id: row.user_id,
    plan_code: planCode,
    plan_name: row.plan_name || PLAN_LEVELS[planCode]?.label || "Free",
    status: row.status || "active",
    source: row.source || "free",
    starts_at: row.starts_at || null,
    ends_at: row.ends_at || null,
    features: { ...(row.plan_features || {}), ...(row.features_override || {}) }
  };
}

function dateISO(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value, fallback = "") {
  return String(value ?? fallback ?? "").trim();
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function hasArray(value) {
  return Array.isArray(value) && value.some(item => hasValue(item));
}

function validateFirstPlanSetup(data) {
  const profile = data.profile || {};
  const workout = data.workout_availability || {};
  const work = data.work_schedule || {};
  const food = data.food_preferences || {};
  const water = data.water_settings || {};
  const latestMeasurement = safeArray(data.measurements)[0] || {};
  const missing = [];

  const add = (section, label, ready) => {
    if (!ready) missing.push(`${section}: ${label}`);
  };

  add("Personal information", "full name", hasValue(profile.full_name));
  add("Personal information", "date of birth", hasValue(profile.date_of_birth));
  add("Personal information", "gender", hasValue(profile.gender));
  add("Personal information", "height", Number(profile.height_cm) > 0);
  add("Personal information", "current weight", Number(profile.starting_weight || latestMeasurement.weight) > 0);
  add("Goals and body", "main fitness goal", hasArray(profile.main_goals) || hasValue(profile.main_goal));
  add("Goals and body", "body type", hasValue(profile.body_type));

  add("Workout setup", "workout place", hasValue(workout.workout_place));
  add("Workout setup", "workout days", hasArray(workout.workout_days));
  add("Workout setup", "time available", Number(workout.max_minutes) > 0);
  add("Workout setup", "training experience", hasValue(workout.experience_level));
  add("Workout setup", "training split", hasValue(workout.preferred_split));
  add("Workout setup", "equipment preference", hasArray(workout.equipment));

  add("Pain and safety", "pain or no-pain selection", hasArray(workout.pain_areas));
  add("Pain and safety", "pain rating", hasValue(workout.pain_rating));

  const notWorking = ["not_working", "retired", "student_no_job"].includes(
    String(work.job_activity || "").toLowerCase()
  );

  if (!notWorking) {
    add("Work schedule", "work days", hasArray(work.work_days));
    add("Work schedule", "work start time", hasValue(work.work_start));
    add("Work schedule", "work end time", hasValue(work.work_end));
    add("Work schedule", "job activity", hasValue(work.job_activity));
    add("Work schedule", "at least one break or eating window", hasArray(work.breaks));
  }

  add("Food setup", "diet type", hasValue(food.diet_type));
  add("Food setup", "cuisine preference", hasArray(food.food_styles) || hasValue(food.food_style));
  add("Food setup", "protein preferences", hasArray(food.preferred_proteins));
  add("Food setup", "carb preferences", hasArray(food.preferred_carbs));
  add("Food setup", "allergy or no-allergy selection", hasArray(food.allergies));
  add("Food setup", "smoothie preference", typeof food.likes_smoothies === "boolean");
  add("Food setup", "whey preference", typeof food.uses_whey_protein === "boolean");
  add("Food setup", "usual or favourite foods", hasValue(food.usual_foods) || hasValue(food.favourite_foods));
  add("Food setup", "meal prep style", hasValue(food.meal_prep_style));

  add("Water setup", "bottle size", Number(water.bottle_size_ml) > 0);
  add("Water setup", "daily water target", Number(water.daily_target_liters || water.target_liters) > 0);

  return { complete: missing.length === 0, missing };
}

function compactRows(rows, fields, limit = 20) {
  return safeArray(rows).slice(0, limit).map(row => {
    const out = {};
    for (const key of fields) {
      const value = row?.[key];
      if (value !== undefined && value !== null && value !== "") out[key] = value;
    }
    return out;
  });
}

function getOutputText(openaiData) {
  if (openaiData?.output_text) return openaiData.output_text;
  return safeArray(openaiData?.output)
    .flatMap(item => safeArray(item?.content))
    .map(part => part?.text || part?.output_text || "")
    .join("")
    .trim();
}

function extractJson(output) {
  let value = String(output || "").trim();
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    value = fenced[1].trim();
  } else {
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start >= 0 && end > start) value = value.slice(start, end + 1);
  }
  return JSON.parse(value);
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

async function expireOldEntitlements(db, userId) {
  const now = new Date().toISOString();
  await db
    .from("user_entitlements")
    .update({ status: "expired", updated_at: now })
    .eq("user_id", userId)
    .in("status", ["active", "trialing"])
    .not("ends_at", "is", null)
    .lt("ends_at", now);
}

async function readCurrentEntitlement(db, userId) {
  const { data, error } = await db
    .from("current_user_entitlements")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return cleanEntitlement(data);
}

async function createFreeEntitlement(db, userId) {
  const now = new Date().toISOString();
  const { error } = await db
    .from("user_entitlements")
    .insert({
      user_id: userId,
      plan_code: "free",
      status: "active",
      source: "free",
      starts_at: now,
      ends_at: null,
      notes: "Default free access"
    });

  if (error) throw error;

  await db
    .from("profiles")
    .update({
      selected_plan_code: "free",
      onboarding_plan_selected: true,
      is_premium: false,
      updated_at: now
    })
    .eq("id", userId);
}

async function ensureEntitlement(db, userId) {
  await expireOldEntitlements(db, userId);
  let entitlement = await readCurrentEntitlement(db, userId);
  if (!entitlement) {
    await createFreeEntitlement(db, userId);
    entitlement = await readCurrentEntitlement(db, userId);
  }

  return entitlement || {
    id: null,
    user_id: userId,
    plan_code: "free",
    plan_name: "Free",
    status: "active",
    source: "free",
    features: {}
  };
}

async function readUserData(db, userId) {
  const results = await Promise.all([
    db.from("profiles").select("*").eq("id", userId).maybeSingle(),
    db.from("food_preferences").select("*").eq("user_id", userId).maybeSingle(),
    db.from("work_schedules").select("*").eq("user_id", userId).maybeSingle(),
    db.from("workout_availability").select("*").eq("user_id", userId).maybeSingle(),
    db.from("water_settings").select("*").eq("user_id", userId).maybeSingle(),
    db.from("measurements").select("*").eq("user_id", userId).order("entry_date", { ascending: false }).limit(8),
    db.from("daily_logs").select("*").eq("user_id", userId).order("log_date", { ascending: false }).limit(21),
    db.from("meal_logs").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(80),
    db.from("water_logs").select("*").eq("user_id", userId).order("log_date", { ascending: false }).limit(21),
    db.from("workout_sessions").select("*").eq("user_id", userId).order("workout_date", { ascending: false }).limit(12),
    db.from("exercise_logs").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(100),
    db.from("exercise_set_logs").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(160),
    db.from("pain_logs").select("*").eq("user_id", userId).order("logged_at", { ascending: false }).limit(50),
    db.from("exercises").select("*").order("category", { ascending: true }),
    db.from("weekly_plans").select("id,title,week_start,week_end,status,ai_summary,created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(4)
  ]);

  const firstError = results.map(result => result.error).find(Boolean);
  if (firstError) throw new Error(firstError.message || "Could not read user data.");

  const [profile, food, work, workout, water, measurements, daily, meals, waterLogs, sessions, exercises, sets, pain, library, previous] = results;
  const allExercises = library.data || [];
  const approved = allExercises.filter(item => item.approved !== false);
  const planReady = approved.filter(item => item.plan_ready === true);
  const usable = planReady.length >= 8 ? planReady : (approved.length ? approved : allExercises);

  return {
    profile: profile.data,
    food_preferences: food.data,
    work_schedule: work.data,
    workout_availability: workout.data,
    water_settings: water.data,
    measurements: measurements.data || [],
    daily_logs: daily.data || [],
    meal_logs: meals.data || [],
    water_logs: waterLogs.data || [],
    workout_sessions: sessions.data || [],
    exercise_logs: exercises.data || [],
    exercise_set_logs: sets.data || [],
    pain_logs: pain.data || [],
    approved_exercise_library: usable,
    previous_plans: previous.data || [],
    exercise_library_status: {
      mode: planReady.length >= 8 ? "plan_ready_only" : "approved_fallback",
      total: allExercises.length,
      approved: approved.length,
      plan_ready: planReady.length,
      used_for_ai: usable.length
    }
  };
}

function buildAiUserData(data) {
  const profile = data.profile || {};
  const food = data.food_preferences || {};
  const exerciseFields = [
    "id", "name", "category", "section", "target_muscle", "equipment", "difficulty",
    "short_cue", "safe_alternative", "back_safe", "knee_safe", "shoulder_safe",
    "usage_priority", "plan_ready"
  ];

  return {
    profile: {
      date_of_birth: profile.date_of_birth || null,
      gender: profile.gender || null,
      height_cm: profile.height_cm || null,
      starting_weight: profile.starting_weight || null,
      weight_unit: profile.weight_unit || null,
      body_type: profile.body_type || null,
      body_type_custom: profile.body_type_custom || null,
      main_goal: profile.main_goal || null,
      main_goals: profile.main_goals || null,
      preferred_language: profile.preferred_language || "en"
    },
    food_preferences: food,
    work_schedule: data.work_schedule || {},
    workout_availability: data.workout_availability || {},
    water_settings: data.water_settings || {},
    measurements: compactRows(data.measurements, ["entry_date", "weight", "waist", "chest", "hips", "thigh", "unit", "notes"], 6),
    recent_checkins: compactRows(data.daily_logs, ["log_date", "meals_status", "water_status", "workout_status", "sleep_quality", "energy", "digestion", "mood", "notes"], 14),
    recent_meals: compactRows(data.meal_logs, ["created_at", "meal_name", "status", "hunger_after", "notes"], 24),
    recent_water: compactRows(data.water_logs, ["log_date", "status", "bottles_done", "target_liters", "bottle_size_ml"], 14),
    recent_workouts: compactRows(data.workout_sessions, ["workout_date", "workout_type", "status", "duration_minutes", "notes"], 10),
    recent_exercise_logs: compactRows(data.exercise_logs, ["created_at", "exercise_name", "section", "actual_weight", "actual_reps", "effort", "pain_level", "pain_area", "skipped", "notes"], 35),
    recent_set_logs: compactRows(data.exercise_set_logs, ["created_at", "exercise_name", "set_number", "weight", "reps", "effort", "pain_level"], 50),
    recent_pain_logs: compactRows(data.pain_logs, ["logged_at", "exercise_name", "pain_area", "pain_level", "pain_score", "notes"], 15),
    previous_plans: compactRows(data.previous_plans, ["title", "week_start", "week_end", "status", "ai_summary", "created_at"], 4),
    approved_exercise_library: compactRows(data.approved_exercise_library, exerciseFields, 100),
    exercise_library_status: data.exercise_library_status
  };
}

function buildPrompt(data, entitlement, requestInfo) {
  const tier = planTierInfo(entitlement);
  return `
You are ShapeCue AI, a careful personal trainer and practical nutrition coach.

MEMBERSHIP: ${tier.label} (${tier.code})
REQUEST SOURCE: ${requestInfo.request_source}
${tier.instruction}

PRODUCT GOAL:
Create a realistic daily coach plan for a busy person. It must clearly answer what to eat, what to train, and what to report.

NON-NEGOTIABLE PERSONALIZATION:
- Use the user's actual schedule, work breaks, workout days, maximum workout time, goals, food preferences, allergies, avoid foods, usual foods, measurements, pain logs, exercise logs, and previous plans.
- Only explicit allergies, avoid foods, and diet-type restrictions are hard food blocks.
- Missing or false food toggles do not mean the user refuses that food.
- Use practical home and work meals. Never write vague advice such as "eat balanced food".
- Include protein in main meals when muscle or body-shape goals are present.
- Use realistic amounts such as roti count, milk volume, oats grams, yogurt amount, eggs, paneer, tofu, chicken, dal, or whey when permitted.
- Give 1-2 practical replacements for every food item.
- Match short work breaks with fast snacks and longer breaks with full packed meals.
- If work is already physically demanding or step-heavy, do not add unnecessary cardio.

WORKOUT SAFETY:
- Use only exercise names found in approved_exercise_library, matching names exactly.
- Every workout must contain warmup, main, and stretch sections.
- Prefer machines, cables, dumbbells, and controlled movements for beginners.
- Use recent effort, reps, weight, skipped exercises, and pain to progress or reduce exercises.
- If pain was high, sharp, or worsening, replace the movement with a safer library option.
- For lower-back concerns, avoid ego deadlifts, risky loaded bending, and heavy back-loaded squats.
- Most working sets should finish with about 1-2 reps remaining.

EVERY EXERCISE MUST INCLUDE:
name, section, planned_sets, sets, target_weight, target_reps, weight_step, rest_seconds, cue, target_muscle, coach_note.

EVERY FOOD ITEM MUST INCLUDE:
time, title, text, type="food", estimated_protein_g, prep_minutes, work_friendly, ingredients, replacement_options, coach_note.

Return only valid JSON. No markdown and no text outside JSON.

Use this exact top-level shape:
{
  "next_week_plan": {
    "title": "ShapeCue Coach Plan",
    "plan_code": "${tier.code}",
    "generation_type": "${tier.generationType}",
    "start_date": "${dateISO(0)}",
    "end_date": "${dateISO(6)}",
    "summary": "short summary",
    "coach_reasoning": "why this plan fits",
    "safety_note": "short safety note",
    "weekly_structure": [],
    "targets": [],
    "water_goal": {
      "target_liters": 2,
      "bottle_size_ml": 1000,
      "bottles_per_day": 2,
      "note": "short note"
    },
    "daily_schedule": {
      "Sunday": [], "Monday": [], "Tuesday": [], "Wednesday": [],
      "Thursday": [], "Friday": [], "Saturday": []
    },
    "workouts": { "push": [], "legs": [], "pull": [], "mobility": [] },
    "meal_prep_plan": {
      "prep_day": "Saturday",
      "fridge_items": [], "freezer_items": [], "fresh_items": [], "packing_notes": []
    },
    "grocery_list": [],
    "bloating_control": [],
    "daily_checklist": [],
    "weekly_focus": [],
    "ai_adjustments": [],
    "feature_locks": {}
  }
}

DAILY REQUIREMENTS:
- Build all seven days.
- Workdays should include breakfast, break food based on actual break times, an after-work option, dinner, and recovery/mobility where useful.
- Gym days should include pre-workout, a gym item with workout key, post-workout food, and regular meals.
- Every day should usually contain at least five useful items.

WORKOUT REQUIREMENTS:
- Push: warmup, chest/shoulders/triceps, optional safe core, stretch.
- Legs: warmup, thighs/glutes with back-safe choices, stretch.
- Pull: warmup, back/biceps/posture, stretch.
- Mobility: short recovery-focused session.

REQUEST INFO:
${JSON.stringify(requestInfo, null, 2)}

USER DATA:
${JSON.stringify(buildAiUserData(data), null, 2)}
`;
}

function exerciseLookup(library) {
  const map = new Map();
  for (const item of safeArray(library)) {
    if (!item?.name) continue;
    map.set(String(item.name).trim().toLowerCase(), item);
  }
  return map;
}

function fallbackExercise(library, section) {
  return safeArray(library).find(item => String(item.section || "").toLowerCase() === String(section || "main").toLowerCase())
    || safeArray(library).find(item => item.back_safe === true)
    || safeArray(library)[0]
    || null;
}

function sanitizeExercise(item, library, lookup, workoutKey) {
  const raw = safeObject(item);
  const exact = lookup.get(text(raw.name).toLowerCase());
  const source = exact || fallbackExercise(library, raw.section || workoutKey);
  if (!source?.name) return null;

  const sets = Math.max(1, Math.min(6, Math.round(number(raw.planned_sets, 3))));
  const reps = Math.max(1, Math.min(30, Math.round(number(raw.target_reps, 10))));

  return {
    name: source.name,
    exercise_id: source.id || raw.exercise_id || null,
    section: text(raw.section, source.section || "main"),
    planned_sets: sets,
    sets: text(raw.sets, `${sets} x ${reps}`),
    target_weight: number(raw.target_weight, 0),
    target_reps: reps,
    weight_step: number(raw.weight_step, 5),
    rest_seconds: Math.max(30, Math.min(180, Math.round(number(raw.rest_seconds, 90)))),
    cue: text(raw.cue, source.short_cue || "Use controlled form and stop if pain increases."),
    target_muscle: text(raw.target_muscle, source.target_muscle || "Main muscle"),
    coach_note: text(raw.coach_note, "Included because it fits this session and the user's recent feedback."),
    image_url: source.image_url || null,
    video_url: source.video_url || null,
    image_path: source.image_path || null,
    video_path: source.video_path || null,
    guide_steps: safeArray(source.guide_steps),
    common_mistakes: safeArray(source.common_mistakes),
    common_mistake: source.common_mistake || null,
    pain_warning: source.pain_warning || null,
    alternatives: safeArray(source.alternatives),
    safe_alternative: source.safe_alternative || null,
    usage_priority: source.usage_priority || "medium",
    plan_ready: source.plan_ready === true
  };
}

function sanitizeFoodItem(item) {
  const raw = safeObject(item);
  const replacements = safeArray(raw.replacement_options).map(value => text(value)).filter(Boolean).slice(0, 2);
  return {
    time: text(raw.time),
    title: text(raw.title, "Meal"),
    text: text(raw.text, "Protein-focused practical meal"),
    type: "food",
    estimated_protein_g: number(raw.estimated_protein_g, 0),
    prep_minutes: number(raw.prep_minutes, 0),
    work_friendly: raw.work_friendly === undefined ? true : Boolean(raw.work_friendly),
    ingredients: safeArray(raw.ingredients).slice(0, 14),
    replacement_options: replacements.length ? replacements : [
      "Similar home meal with a practical protein source",
      "Eggs, yogurt/curd, tofu, paneer, chicken, dal, or whey when allowed"
    ],
    coach_note: text(raw.coach_note, "Placed here to support energy and protein consistency.")
  };
}

function sanitizeDailySchedule(schedule) {
  const result = {};
  for (const day of DAYS) {
    result[day] = safeArray(schedule?.[day]).map(item => {
      const raw = safeObject(item);
      if (text(raw.type).toLowerCase() === "food") return sanitizeFoodItem(raw);
      return {
        ...raw,
        time: text(raw.time),
        title: text(raw.title, raw.type === "gym" ? "Gym" : "Plan item"),
        text: text(raw.text),
        type: text(raw.type, "note")
      };
    });
  }
  return result;
}

function sanitizeWorkouts(workouts, library) {
  const lookup = exerciseLookup(library);
  const result = {};
  for (const key of ["push", "legs", "pull", "mobility"]) {
    result[key] = safeArray(workouts?.[key])
      .map(item => sanitizeExercise(item, library, lookup, key))
      .filter(Boolean);
  }
  return result;
}

function safetyFlags(plan, data) {
  const flags = [];
  const source = JSON.stringify({ profile: data.profile, pain: data.pain_logs }).toLowerCase();
  if (source.includes("back")) {
    flags.push({ type: "back_safe", message: "Use back-safe loading and controlled range." });
  }
  if (safeArray(data.pain_logs).some(item => number(item.pain_level ?? item.pain_score ?? item.pain_rating, 0) >= 5)) {
    flags.push({ type: "pain_5_plus", message: "Recent pain at 5+ requires safer substitutions and stopping painful movements." });
  }
  const planText = JSON.stringify(plan).toLowerCase();
  if (planText.includes("deadlift") || planText.includes("back squat")) {
    flags.push({ type: "loading_review", message: "Review heavy loading against current pain and experience." });
  }
  return flags;
}

function sanitizePlan(rawPlan, data, entitlement) {
  const tier = planTierInfo(entitlement);
  const raw = safeObject(rawPlan);
  const progressPhotosLocked = !["premium", "coach"].includes(tier.code);
  const smartReplacementsLocked = !["premium", "coach"].includes(tier.code);

  const plan = {
    title: text(raw.title, "ShapeCue Coach Plan"),
    plan_code: tier.code,
    generation_type: tier.generationType,
    start_date: text(raw.start_date, dateISO(0)),
    end_date: text(raw.end_date, dateISO(6)),
    summary: text(raw.summary, "Your ShapeCue plan is ready."),
    coach_reasoning: text(raw.coach_reasoning, "Built from your goals, schedule, preferences, and recent logs."),
    safety_note: text(raw.safety_note, "Use controlled form and stop movements that cause sharp or increasing pain."),
    weekly_structure: safeArray(raw.weekly_structure),
    targets: safeArray(raw.targets).slice(0, 10),
    water_goal: {
      target_liters: number(raw.water_goal?.target_liters, data.water_settings?.daily_target_liters || 2),
      bottle_size_ml: number(raw.water_goal?.bottle_size_ml, data.water_settings?.bottle_size_ml || 1000),
      bottles_per_day: number(raw.water_goal?.bottles_per_day, 2),
      note: text(raw.water_goal?.note, "Sip consistently through the day.")
    },
    daily_schedule: sanitizeDailySchedule(raw.daily_schedule),
    workouts: sanitizeWorkouts(raw.workouts, data.approved_exercise_library),
    meal_prep_plan: {
      prep_day: text(raw.meal_prep_plan?.prep_day, "Saturday"),
      fridge_items: safeArray(raw.meal_prep_plan?.fridge_items),
      freezer_items: safeArray(raw.meal_prep_plan?.freezer_items),
      fresh_items: safeArray(raw.meal_prep_plan?.fresh_items),
      packing_notes: safeArray(raw.meal_prep_plan?.packing_notes)
    },
    grocery_list: safeArray(raw.grocery_list),
    bloating_control: safeArray(raw.bloating_control),
    daily_checklist: safeArray(raw.daily_checklist),
    weekly_focus: safeArray(raw.weekly_focus),
    ai_adjustments: safeArray(raw.ai_adjustments),
    feature_locks: {
      ...safeObject(raw.feature_locks),
      pdf_export: tier.code === "free",
      progress_photos: progressPhotosLocked,
      smart_replacements: smartReplacementsLocked
    }
  };

  plan.safety_flags = safetyFlags(plan, data);
  return plan;
}

function validatePlan(plan) {
  if (!plan || typeof plan !== "object") throw new Error("AI returned an empty plan.");
  for (const day of DAYS) {
    if (!Array.isArray(plan.daily_schedule?.[day])) {
      throw new Error(`AI plan is missing the ${day} schedule.`);
    }
  }
  for (const key of ["push", "legs", "pull", "mobility"]) {
    if (!Array.isArray(plan.workouts?.[key])) {
      throw new Error(`AI plan is missing the ${key} workout.`);
    }
  }
}

async function failAndRefund(db, requestId, userId, errorMessage, responsePayload = null) {
  if (!db || !requestId || !userId) return null;
  const { data, error } = await db.rpc("fail_ai_plan_request_and_refund", {
    p_request_id: requestId,
    p_user_id: userId,
    p_error_message: String(errorMessage || "Plan generation failed."),
    p_response_payload: responsePayload
  });

  if (error) {
    console.error("Secure failure/refund RPC failed:", error);
    await db
      .from("ai_requests")
      .update({ status: "failed", error_message: String(errorMessage || "Plan generation failed.") })
      .eq("id", requestId)
      .eq("user_id", userId);
    return null;
  }
  return data || null;
}

function trustedSchedulerRequest(event) {
  const expected = String(process.env.SHAPECUE_SCHEDULER_SECRET || "");
  const provided = String(
    event.headers["x-shapecue-scheduler-secret"] ||
    event.headers["X-ShapeCue-Scheduler-Secret"] ||
    ""
  );

  return expected.length >= 24 && provided === expected;
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "Use POST." });
  }

  let db = null;
  let requestId = null;
  let userId = null;
  let requestSource = "";

  try {
    const openaiKey = process.env.OPENAI_API_KEY;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!openaiKey) return jsonResponse(500, { ok: false, error: "OPENAI_API_KEY missing in Netlify." });
    if (!serviceRoleKey) return jsonResponse(500, { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY missing in Netlify." });

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }
    requestId = body.request_id || body.ai_request_id || null;
    if (!requestId) return jsonResponse(400, { ok: false, error: "request_id missing." });

    db = createClient(SUPABASE_URL, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const requestRes = await db
      .from("ai_requests")
      .select("*")
      .eq("id", requestId)
      .maybeSingle();

    if (requestRes.error) throw requestRes.error;
    if (!requestRes.data) return jsonResponse(404, { ok: false, error: "AI request not found." });

    const requestRow = requestRes.data;
    const access = requestRow.prompt_payload?.access || {};
    requestSource = String(access.request_source || "");

    const internalScheduler = trustedSchedulerRequest(event);

    if (internalScheduler) {
      if (requestSource !== "scheduled_auto") {
        const err = new Error("Scheduler authorization is valid only for scheduled membership updates.");
        err.statusCode = 403;
        throw err;
      }
      userId = requestRow.user_id;
    } else {
      const user = await getUserFromToken(db, event);
      userId = user.id;

      if (requestRow.user_id !== userId) {
        return jsonResponse(404, { ok: false, error: "AI request not found." });
      }
    }

    if (!["first_plan", "admin_manual", "addon_credit", "scheduled_auto"].includes(requestSource)) {
      const err = new Error("This AI request was not authorized by ShapeCue.");
      err.statusCode = 403;
      throw err;
    }

    if (requestRow.status === "completed") {
      return jsonResponse(200, { ok: true, status: "completed" });
    }
    if (requestRow.status === "failed") {
      return jsonResponse(409, { ok: false, status: "failed", error: requestRow.error_message || "AI request failed." });
    }

    const { data: claim, error: claimError } = await db.rpc("claim_ai_plan_request", {
      p_request_id: requestId,
      p_user_id: userId
    });
    if (claimError) throw claimError;

    if (!claim?.claimed) {
      if (claim?.status === "completed") return jsonResponse(200, { ok: true, status: "completed" });
      if (claim?.status === "failed") return jsonResponse(409, { ok: false, status: "failed", error: "AI request failed." });
      return jsonResponse(202, {
        ok: true,
        status: claim?.status || "processing",
        already_processing: true,
        message: "Your AI coach is already generating this plan."
      });
    }

    const entitlement = await ensureEntitlement(db, userId);
    const tier = planTierInfo(entitlement);

    if (requestSource === "scheduled_auto" && !["plus", "premium", "coach"].includes(tier.code)) {
      await db
        .from("profiles")
        .update({
          auto_plan_update_status: "not_included",
          next_plan_update_at: null,
          auto_plan_queued_at: null,
          auto_plan_last_error: null,
          auto_plan_retry_count: 0
        })
        .eq("id", userId);

      const err = new Error("Automatic AI updates are no longer included in this membership.");
      err.statusCode = 403;
      err.disableAutoSchedule = true;
      throw err;
    }

    if (requestSource === "scheduled_auto") {
      await db
        .from("profiles")
        .update({
          auto_plan_update_status: "processing",
          auto_plan_queued_at: requestRow.created_at || new Date().toISOString(),
          auto_plan_last_error: null
        })
        .eq("id", userId);
    }

    const userData = await readUserData(db, userId);

    if (!userData.profile?.onboarding_completed) throw new Error("Onboarding is not completed.");

    if (requestSource === "first_plan") {
      const setupStatus = validateFirstPlanSetup(userData);
      if (!setupStatus.complete) {
        const err = new Error(`SETUP_INCOMPLETE: ${setupStatus.missing.join(", ")}`);
        err.statusCode = 422;
        err.responsePayload = { missing_setup: setupStatus.missing };
        throw err;
      }
    }

    if (!userData.approved_exercise_library.length) {
      throw new Error("Exercise library is empty. Add approved exercises before generating a workout plan.");
    }

    const requestInfo = {
      request_source: requestSource,
      plan_code: tier.code,
      plan_name: tier.label,
      generation_type: tier.generationType,
      first_plan: requestSource === "first_plan",
      admin_manual: requestSource === "admin_manual",
      extra_addon_used: requestSource === "addon_credit",
      scheduled_membership_update: requestSource === "scheduled_auto",
      exercise_library_mode: userData.exercise_library_status.mode,
      exercises_available: userData.exercise_library_status.used_for_ai
    };

    const inputSummary = {
      plan_code: tier.code,
      request_source: requestSource,
      profile: {
        gender: userData.profile.gender || null,
        date_of_birth: userData.profile.date_of_birth || null,
        goals: userData.profile.main_goals || userData.profile.main_goal || null,
        body_type: userData.profile.body_type || null
      },
      data_counts: {
        measurements: userData.measurements.length,
        daily_logs: userData.daily_logs.length,
        meal_logs: userData.meal_logs.length,
        workout_sessions: userData.workout_sessions.length,
        exercise_logs: userData.exercise_logs.length,
        pain_logs: userData.pain_logs.length
      }
    };

    await db
      .from("ai_requests")
      .update({
        model: MODEL,
        prompt_payload: {
          ...(requestRow.prompt_payload || {}),
          entitlement,
          request_info: requestInfo,
          input_summary: inputSummary,
          compact_user_data: buildAiUserData(userData)
        }
      })
      .eq("id", requestId)
      .eq("user_id", userId);

    const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        input: buildPrompt(userData, entitlement, requestInfo),
        text: { format: { type: "json_object" } },
        max_output_tokens: tier.maxOutputTokens
      })
    });

    const openaiData = await openaiResponse.json();
    if (!openaiResponse.ok) {
      const err = new Error(openaiData?.error?.message || `OpenAI request failed (${openaiResponse.status}).`);
      err.statusCode = openaiResponse.status;
      err.responsePayload = openaiData;
      throw err;
    }

    const outputText = getOutputText(openaiData);
    let parsed;
    try {
      parsed = extractJson(outputText);
    } catch (parseError) {
      const err = new Error("AI returned invalid JSON. Any reserved add-on will be returned when applicable.");
      err.responsePayload = {
        parse_error: parseError.message || "JSON parse failed",
        openai_status: openaiData.status || null,
        incomplete_details: openaiData.incomplete_details || null,
        output_length: outputText.length,
        raw_output_preview: outputText.slice(0, 12000),
        raw_output_end: outputText.slice(-12000),
        usage: openaiData.usage || null
      };
      throw err;
    }

    const plan = sanitizePlan(parsed.next_week_plan || parsed, userData, entitlement);
    validatePlan(plan);

    const savedPlanRes = await db
      .from("weekly_plans")
      .insert({
        user_id: userId,
        week_start: plan.start_date || dateISO(0),
        week_end: plan.end_date || dateISO(6),
        title: plan.title,
        status: "active",
        plan_json: plan,
        ai_summary: plan.summary,
        generated_by: "ai",
        is_premium_plan: tier.isPremium,
        plan_code: tier.code,
        generation_type: tier.generationType,
        entitlement_id: entitlement.id || null,
        model_used: MODEL,
        input_summary: inputSummary,
        safety_flags: plan.safety_flags || []
      })
      .select()
      .single();

    if (savedPlanRes.error) throw savedPlanRes.error;

    await db
      .from("weekly_plans")
      .update({ status: "archived" })
      .eq("user_id", userId)
      .eq("status", "active")
      .neq("id", savedPlanRes.data.id);

    const completeRes = await db
      .from("ai_requests")
      .update({
        status: "completed",
        error_message: null,
        response_payload: {
          ...(requestRow.response_payload || {}),
          plan_id: savedPlanRes.data.id,
          plan_title: plan.title,
          plan_summary: plan.summary,
          request_source: requestSource,
          completed_at: new Date().toISOString(),
          usage: openaiData.usage || null
        },
        input_tokens: openaiData.usage?.input_tokens || null,
        output_tokens: openaiData.usage?.output_tokens || null
      })
      .eq("id", requestId)
      .eq("user_id", userId);

    if (completeRes.error) throw completeRes.error;

    if (["first_plan", "scheduled_auto"].includes(requestSource)) {
      const now = new Date();
      const profileUpdate = {
        auto_plan_update_status: "not_included",
        next_plan_update_at: null,
        auto_plan_queued_at: null,
        auto_plan_retry_count: 0,
        auto_plan_last_error: null
      };

      if (tier.code === "plus") {
        const next = new Date(now);
        next.setUTCMonth(next.getUTCMonth() + 1);
        profileUpdate.next_plan_update_at = next.toISOString();
        profileUpdate.auto_plan_update_status = "scheduled";
      }

      if (tier.code === "premium") {
        const next = new Date(now);
        next.setUTCDate(next.getUTCDate() + 14);
        profileUpdate.next_plan_update_at = next.toISOString();
        profileUpdate.auto_plan_update_status = "scheduled";
      }

      if (tier.code === "coach") {
        const next = new Date(now);
        next.setUTCDate(next.getUTCDate() + 7);
        profileUpdate.next_plan_update_at = next.toISOString();
        profileUpdate.auto_plan_update_status = "scheduled";
      }

      if (requestSource === "scheduled_auto") {
        profileUpdate.last_auto_plan_update_at = now.toISOString();
      }

      await db
        .from("profiles")
        .update(profileUpdate)
        .eq("id", userId);
    }

    return jsonResponse(200, {
      ok: true,
      status: "completed",
      plan_id: savedPlanRes.data.id,
      request_source: requestSource,
      message: `${tier.label} coach plan generated and saved.`
    });
  } catch (error) {
    console.error(error);

    let failure = null;
    if (db && requestId && userId) {
      try {
        failure = await failAndRefund(
          db,
          requestId,
          userId,
          error.message || "Plan generation failed.",
          error.responsePayload || null
        );

        if (requestSource === "scheduled_auto" && error.disableAutoSchedule) {
          await db
            .from("profiles")
            .update({
              auto_plan_update_status: "not_included",
              next_plan_update_at: null,
              auto_plan_queued_at: null,
              auto_plan_retry_count: 0,
              auto_plan_last_error: null
            })
            .eq("id", userId);
        }
      } catch (refundError) {
        console.error("Could not record failure/refund:", refundError);
      }
    }

    return jsonResponse(error.statusCode || 500, {
      ok: false,
      error: error.message || "Plan generation failed.",
      credit_refunded: Boolean(failure?.refunded),
      extra_updates_remaining: Number.isFinite(Number(failure?.extra_updates_remaining))
        ? Number(failure.extra_updates_remaining)
        : null
    });
  }
}
