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
    label: "Free User",
    generationType: "starter",
    isPremium: false,
    depth: "starter",
    maxOutputTokens: 3000,
    planInstruction: `
FREE USER PLAN RULES:
- Create a useful 7-day starter plan, but keep it simple.
- Give enough daily guidance for Today screen.
- Do not include advanced smart replacements.
- Keep meal replacement options basic.
- Progress photos, PDF export, grocery list, and weekly AI updates are locked in UI.
- Still keep the plan safe and practical.
`
  },
  premium: {
    label: "Premium",
    generationType: "premium_biweekly",
    isPremium: true,
    depth: "full",
    maxOutputTokens: 3000,
    planInstruction: `
PREMIUM PLAN RULES:
- Create a full practical 7-day plan.
- Include gym-day, work-day, and off-day meal timing.
- Include grocery list and meal prep plan.
- Include exact foods, protein estimate, prep notes, and 1-2 replacements per meal.
- Include exercise cues and safe alternatives.
- Plan should feel like a paid coach made it.
`
  },
  premium_plus: {
    label: "Premium Plus",
    generationType: "premium_plus_weekly",
    isPremium: true,
    depth: "advanced",
    maxOutputTokens: 3000,
    planInstruction: `
PREMIUM PLUS PLAN RULES:
- Create the strongest version of the plan.
- Include weekly coach reasoning, smart replacements, advanced progress-based adjustments, and safety flags.
- Meals must include practical recipe-style detail, protein estimates, prep time, work-friendly notes, and replacements.
- Workout must include progression logic from logs, pain-aware changes, and form cues.
- Include exactly why next week changed compared with previous logs/plans.
- Add advanced weekly review targets and coach notes.
- This should feel like a premium weekly online coach update, not a generic AI plan.
`
  }
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

function dateISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function startOfCurrentMonthISO() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function getOutputText(openaiData) {
  if (openaiData.output_text) return openaiData.output_text;

  try {
    return (openaiData.output || [])
      .flatMap(item => item.content || [])
      .map(part => part.text || part.output_text || "")
      .join("")
      .trim();
  } catch {
    return "";
  }
}

function extractJson(text) {
  let t = String(text || "").trim();

  const codeBlock = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeBlock) {
    t = codeBlock[1].trim();
  } else {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      t = t.slice(start, end + 1);
    }
  }

  return JSON.parse(t);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeText(value, fallback = "") {
  return String(value || fallback || "").trim();
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function planTierInfo(entitlement) {
  const code = entitlement?.plan_code || "free";
  return PLAN_LEVELS[code] ? { code, ...PLAN_LEVELS[code] } : { code: "free", ...PLAN_LEVELS.free };
}

function cleanEntitlement(row) {
  if (!row) return null;

  return {
    id: row.id,
    user_id: row.user_id,
    plan_code: row.plan_code || "free",
    plan_name: row.plan_name || row.plan_code || "Free User",
    status: row.status || "active",
    source: row.source || "free",
    starts_at: row.starts_at || null,
    ends_at: row.ends_at || null,
    features: {
      ...(row.plan_features || {}),
      ...(row.features_override || {})
    }
  };
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

async function isAdmin(db, userId) {
  const { data, error } = await db
    .from("app_admins")
    .select("user_id, role")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) return false;
  return Boolean(data?.user_id);
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
    plan_name: "Free User",
    status: "active",
    source: "free",
    features: PLAN_LEVELS.free
  };
}

async function readUsageLimit(db, planCode) {
  const { data, error } = await db
    .from("ai_usage_limits")
    .select("*")
    .eq("plan_code", planCode)
    .maybeSingle();

  if (error || !data) {
    if (planCode === "premium_plus") return { weekly_plan_generations_per_month: 5 };
    if (planCode === "premium") return { weekly_plan_generations_per_month: 2 };
    return { weekly_plan_generations_per_month: 1 };
  }

  return data;
}

async function countMonthlyPlanGenerations(db, userId) {
  try {
    const { count, error } = await db
      .from("ai_requests")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .in("status", ["pending", "completed"])
      .gte("created_at", startOfCurrentMonthISO())
      .ilike("request_type", "weekly_plan_coach%");

    if (error) return 0;
    return count || 0;
  } catch {
    return 0;
  }
}

async function readUserData(db, userId) {
  const [
    profileRes,
    foodRes,
    workRes,
    workoutRes,
    waterRes,
    measurementRes,
    dailyLogsRes,
    mealLogsRes,
    waterLogsRes,
    workoutSessionsRes,
    exerciseLogsRes,
    setLogsRes,
    painLogsRes,
    exercisesRes,
    previousPlansRes
  ] = await Promise.all([
    db.from("profiles").select("*").eq("id", userId).maybeSingle(),

    db.from("food_preferences").select("*").eq("user_id", userId).maybeSingle(),

    db.from("work_schedules").select("*").eq("user_id", userId).maybeSingle(),

    db.from("workout_availability").select("*").eq("user_id", userId).maybeSingle(),

    db.from("water_settings").select("*").eq("user_id", userId).maybeSingle(),

    db.from("measurements")
      .select("*")
      .eq("user_id", userId)
      .order("entry_date", { ascending: false })
      .limit(8),

    db.from("daily_logs")
      .select("*")
      .eq("user_id", userId)
      .order("log_date", { ascending: false })
      .limit(21),

    db.from("meal_logs")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(80),

    db.from("water_logs")
      .select("*")
      .eq("user_id", userId)
      .order("log_date", { ascending: false })
      .limit(21),

    db.from("workout_sessions")
      .select("*")
      .eq("user_id", userId)
      .order("workout_date", { ascending: false })
      .limit(12),

    db.from("exercise_logs")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(100),

    db.from("exercise_set_logs")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(160),

    db.from("pain_logs")
      .select("*")
      .eq("user_id", userId)
      .order("logged_at", { ascending: false })
      .limit(50),

    db.from("exercises")
      .select("id,name,slug,category,section,target_muscle,equipment,difficulty,image_url,video_url,image_path,video_path,short_cue,common_mistake,common_mistakes,safe_alternative,alternatives,pain_warning,guide_steps,back_safe,knee_safe,shoulder_safe,approved,plan_ready,usage_priority,media_required,media_status,guide_status")
      .order("category", { ascending: true }),

    db.from("weekly_plans")
      .select("id,title,week_start,week_end,status,plan_json,ai_summary,plan_code,generation_type,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(4)
  ]);

  const errors = [
    profileRes.error,
    foodRes.error,
    workRes.error,
    workoutRes.error,
    waterRes.error,
    measurementRes.error,
    dailyLogsRes.error,
    mealLogsRes.error,
    waterLogsRes.error,
    workoutSessionsRes.error,
    exerciseLogsRes.error,
    setLogsRes.error,
    painLogsRes.error,
    exercisesRes.error,
    previousPlansRes.error
  ].filter(Boolean);

  if (errors.length) {
    throw new Error(errors[0].message || "Could not read user data.");
  }

  const allExercises = exercisesRes.data || [];
  const approvedExercises = allExercises.filter(ex => ex.approved !== false);
  const readyExercises = approvedExercises.filter(ex => ex.plan_ready === true);
  const exerciseLibrary = readyExercises.length >= 8
    ? readyExercises
    : (approvedExercises.length ? approvedExercises : allExercises);

  const exerciseLibraryMode = readyExercises.length >= 8
    ? "plan_ready_only"
    : "approved_fallback_not_enough_plan_ready";

  return {
    profile: profileRes.data,
    food_preferences: foodRes.data,
    work_schedule: workRes.data,
    workout_availability: workoutRes.data,
    water_settings: waterRes.data,
    measurements: measurementRes.data || [],
    daily_logs: dailyLogsRes.data || [],
    meal_logs: mealLogsRes.data || [],
    water_logs: waterLogsRes.data || [],
    workout_sessions: workoutSessionsRes.data || [],
    exercise_logs: exerciseLogsRes.data || [],
    exercise_set_logs: setLogsRes.data || [],
    pain_logs: painLogsRes.data || [],
    approved_exercise_library: exerciseLibrary,
    all_exercises: allExercises,
    exercise_library_status: {
      mode: exerciseLibraryMode,
      total: allExercises.length,
      approved: approvedExercises.length,
      plan_ready: readyExercises.length,
      used_for_ai: exerciseLibrary.length,
      missing_media: approvedExercises.filter(ex => (ex.media_status || "missing") === "missing").length,
      missing_guide: approvedExercises.filter(ex => (ex.guide_status || "missing") === "missing").length
    },
    previous_plans: previousPlansRes.data || []
  };
}

function buildInputSummary(userData, entitlement, usageInfo) {
  const p = userData.profile || {};
  const food = userData.food_preferences || {};
  const work = userData.work_schedule || {};
  const workout = userData.workout_availability || {};

  return {
    plan_code: entitlement?.plan_code || "free",
    user: {
      gender: p.gender || null,
      dob: p.date_of_birth || null,
      height_cm: p.height_cm || null,
      starting_weight: p.starting_weight || null,
      weight_unit: p.weight_unit || null,
      body_type: p.body_type || null,
      main_goals: p.main_goals || null
    },
    food: {
      food_style: food.food_style || null,
      usual_foods: food.usual_foods || null,
      preferred_proteins: food.preferred_proteins || null,
      allergies: food.allergies || null,
      avoid_foods: food.avoid_foods || null,
      smoothie_preference: food.smoothie_preference || null,
      whey_preference: food.whey_preference || null
    },
    schedule: {
      work_days: work.work_days || null,
      work_type: work.work_type || null,
      breaks: work.breaks || null,
      workout_days: workout.workout_days || null,
      workout_place: workout.workout_place || null,
      max_minutes: workout.max_minutes || null
    },
    exercise_library: userData.exercise_library_status || {},
    recent_data_counts: {
      measurements: userData.measurements.length,
      daily_logs: userData.daily_logs.length,
      meal_logs: userData.meal_logs.length,
      workout_sessions: userData.workout_sessions.length,
      exercise_logs: userData.exercise_logs.length,
      set_logs: userData.exercise_set_logs.length,
      pain_logs: userData.pain_logs.length,
      previous_plans: userData.previous_plans.length
    },
    usage: usageInfo
  };
}

function buildPrompt(userData, entitlement, usageInfo) {
  const tier = planTierInfo(entitlement);

  return `
You are FitApp AI, a premium personal trainer and practical nutrition coach.

You are generating a plan for plan tier: ${tier.label} (${tier.code}).

${tier.planInstruction}

CORE PRODUCT PROMISE:
This app is not a generic dashboard. It is a daily coach for busy workers.
The plan must answer:
1. What should the user eat today?
2. What should the user train today?
3. What should the user report so next week can adjust?

QUALITY BAR:
- The output must feel like a real trainer reviewed the user's schedule, food preference, pain, logs, and previous plan.
- Do not produce vague fitness advice.
- Do not say "eat a balanced meal" without exact examples.
- Do not create random unrealistic meals.
- Use practical home/work meals the user can actually follow.
- Use coach notes to explain why each meal/workout is placed there.
- If user works heavy_active/high steps, do not add random cardio.
- Make dinner lighter if belly/bloating is a goal.
- Include protein in every main meal if goal includes muscle/shape.
- Include simple water guidance from water settings.

STRICT SAFETY RULES:
- You are not a doctor. Do not diagnose or treat medical conditions.
- If pain is 5+ or sharp pain is reported, reduce risk and recommend stopping that movement and using a safer alternative.
- If lower back pain is present, avoid ego deadlifts, heavy back-loaded squats, risky bending, and loaded back extensions.
- Use back-safe options like machines, chest-supported row, controlled leg press, hip thrust machine, dead bug, Pallof press, face pulls, glute bridge if available in approved library.
- Most sets should stop with 1-2 reps left. Do not train to failure every set.

PERSONALIZATION RULES:
- Use user's real date of birth/age, measurements, goals, body type, work days, breaks, workout days, workout time, food styles, usual foods, favorite foods, disliked foods, allergies, avoid foods, smoothie preference, whey preference, protein preferences, carb preferences, meal prep style, bloating triggers, exercise preferences, pain areas, pain rating, logs, and previous plans.
- Allergies and avoid_foods are HARD BLOCKS. Never include those foods.
- Disliked foods should be avoided unless no other option exists.
- Favorite foods and usual foods should be used strongly.
- If user likes smoothies and uses whey, include smoothie and whey options.
- If user does not use whey, do not include whey.
- If user does not like smoothies, do not include smoothies.
- If user selected Punjabi/Indian/home food, meals should look like real home meals.
- If user prefers roti, rice, oats, wraps, bananas, dates, use those in the plan.
- If user has a short work break, give fast snack only.
- If user has a 30-minute break, give full packed meal.
- If user has fridge_freezer_ok, include fridge/freezer strategy.

WORKOUT RULES:
- Use ONLY approved_exercise_library for exercise names. This is the app-owned exercise library with reusable photos/videos/guides.
- Exercise names must match approved_exercise_library name exactly.
- Prefer exercises with usage_priority "high" or "medium" unless user safety requires another option.
- Every workout must include warmup, main, and stretch sections.
- If approved_exercise_library is missing a perfect exercise, choose the closest safe exercise from that library.
- Never invent exercise names outside approved_exercise_library.
- Do not request new exercise photos. The app reuses media from the library.
- Every exercise must include:
  name, section, planned_sets, sets, target_weight, target_reps, weight_step, rest_seconds, cue, target_muscle, coach_note.
- Workouts must match max_minutes.
- If user is beginner or some_experience, prefer machines, dumbbells, cables, and controlled movements.
- If exercise_logs show hard effort or pain, keep same, reduce, or replace with safer alternative.
- If effort was easy and pain low, slightly increase reps or target weight.

MEAL/RECIPE RULES:
- Give exact meals, not vague "protein + carbs".
- Include amounts when useful: 2 roti, 3 roti, 300 ml milk, 1 scoop whey, 30g oats, 1 banana, 175g yogurt.
- Every food item must include replacement_options with 1-2 practical replacements.
- Every food item should include estimated_protein_g, prep_minutes, work_friendly, ingredients, and coach_note where possible.
- Workday meals must be realistic for breaks.
- Gym-day meals must include pre-workout and post-workout if workout time exists.
- If user allows whey, post-workout whey is allowed.
- If user likes smoothie, breakfast smoothie is allowed.
- If user prefers meal prep, include meal prep plan.

RETURN ONLY VALID JSON.
No markdown.
No comments.
No trailing commas.
No text outside JSON.

RETURN THIS EXACT JSON SHAPE:

{
  "next_week_plan": {
    "title": "FitApp Coach Plan",
    "plan_code": "${tier.code}",
    "generation_type": "${tier.generationType}",
    "start_date": "${dateISO(0)}",
    "end_date": "${dateISO(6)}",
    "summary": "short trainer-style summary",
    "coach_reasoning": "why this plan fits the user",
    "safety_note": "short safety note",
    "weekly_structure": [
      {
        "day": "Sunday",
        "focus": "Work + mobility",
        "reason": "short reason"
      }
    ],
    "targets": [
      "specific target 1",
      "specific target 2",
      "specific target 3"
    ],
    "water_goal": {
      "target_liters": 2,
      "bottle_size_ml": 1000,
      "bottles_per_day": 2,
      "note": "short note"
    },
    "daily_schedule": {
      "Sunday": [],
      "Monday": [],
      "Tuesday": [],
      "Wednesday": [],
      "Thursday": [],
      "Friday": [],
      "Saturday": []
    },
    "workouts": {
      "push": [],
      "legs": [],
      "pull": [],
      "mobility": []
    },
    "meal_prep_plan": {
      "prep_day": "Saturday",
      "fridge_items": [],
      "freezer_items": [],
      "fresh_items": [],
      "packing_notes": []
    },
    "grocery_list": [],
    "bloating_control": [],
    "daily_checklist": [],
    "weekly_focus": [],
    "ai_adjustments": [],
    "feature_locks": {
      "pdf_export": ${tier.code === "free" ? "true" : "false"},
      "progress_photos": ${tier.code === "free" ? "true" : "false"},
      "smart_replacements": ${tier.code === "premium_plus" ? "false" : "true"}
    }
  }
}

DAILY FOOD ITEM FORMAT:
{
  "time": "08:00",
  "title": "Breakfast",
  "text": "300 ml 2% milk smoothie with 1 banana, 1 scoop whey, 30g oats, 1 tbsp peanut butter, cinnamon",
  "type": "food",
  "estimated_protein_g": 28,
  "prep_minutes": 5,
  "work_friendly": true,
  "ingredients": [
    { "name": "2% milk", "amount": "300 ml" },
    { "name": "banana", "amount": "1" }
  ],
  "replacement_options": [
    "2-3 eggs with 1-2 toast/roti and fruit",
    "Greek yogurt/curd bowl with oats and berries if dairy is allowed"
  ],
  "coach_note": "why this meal is placed here"
}

GYM ITEM FORMAT:
{
  "time": "10:45",
  "title": "Gym: Push Day",
  "text": "Chest, shoulders, triceps, core. Start workout mode.",
  "type": "gym",
  "workout": "push"
}

MOBILITY ITEM FORMAT:
{
  "time": "20:30",
  "title": "Short mobility",
  "text": "Cat-cow, glute bridge, dead bug, light stretch.",
  "type": "mobility"
}

WORKOUT EXERCISE FORMAT:
{
  "name": "Machine Chest Press",
  "section": "main",
  "planned_sets": 4,
  "sets": "4 x 8-12",
  "target_weight": 0,
  "target_reps": 10,
  "weight_step": 5,
  "rest_seconds": 90,
  "cue": "Chest up, shoulder blades back, do not over-arch lower back.",
  "target_muscle": "Chest",
  "coach_note": "why this exercise is included"
}

DAILY SCHEDULE REQUIREMENTS:
- Every day must include at least 5 items unless user schedule is extremely limited.
- Workdays should include breakfast, break meals/snacks based on break times, after-work small option, dinner, and optional mobility.
- Gym days should include breakfast, pre-workout, gym item, post-workout, lunch, snack, dinner.
- Every food item must have 1-2 replacement_options.
- Add gym item on workout days.
- Add mobility/recovery item on workdays if useful.

WORKOUT REQUIREMENTS:
- push workout: warmup + chest/shoulders/triceps/main + core if available + stretch.
- legs workout: warmup + thighs/glutes/back-safe main + stretch.
- pull workout: warmup + back/biceps/posture main + stretch.
- mobility workout: short warmup/mobility/stretch only.

USAGE CONTEXT:
${JSON.stringify(usageInfo, null, 2)}

USER DATA:
${JSON.stringify(userData, null, 2)}
`;
}

function buildExerciseLookup(exercises) {
  const byName = new Map();
  const byLower = new Map();

  for (const ex of safeArray(exercises)) {
    if (!ex?.name) continue;
    byName.set(ex.name, ex);
    byLower.set(String(ex.name).trim().toLowerCase(), ex);
  }

  return { byName, byLower };
}

function findFallbackExercise(exercises, sectionOrWorkout = "main") {
  const list = safeArray(exercises);

  const safe = list.find(ex => ex.back_safe === true && String(ex.section || "").toLowerCase().includes("main"));
  if (safe) return safe;

  const sectionMatch = list.find(ex => String(ex.section || "").toLowerCase() === String(sectionOrWorkout || "").toLowerCase());
  if (sectionMatch) return sectionMatch;

  return list[0] || null;
}

function sanitizeExercise(ex, lookup, exercises, workoutKey) {
  const originalName = normalizeText(ex?.name);
  let libraryExercise = lookup.byName.get(originalName) || lookup.byLower.get(originalName.toLowerCase());

  if (!libraryExercise) {
    libraryExercise = findFallbackExercise(exercises, ex?.section || workoutKey);
  }

  if (!libraryExercise?.name) return null;

  const plannedSets = Math.max(1, Math.min(6, Math.round(normalizeNumber(ex?.planned_sets, 3))));
  const targetReps = Math.max(1, Math.min(30, Math.round(normalizeNumber(ex?.target_reps, 10))));
  const restSeconds = Math.max(30, Math.min(180, Math.round(normalizeNumber(ex?.rest_seconds, 90))));

  return {
    name: libraryExercise.name,
    exercise_id: libraryExercise.id || ex?.exercise_id || null,
    section: normalizeText(ex?.section, libraryExercise.section || "main"),
    planned_sets: plannedSets,
    sets: normalizeText(ex?.sets, `${plannedSets} x ${targetReps}`),
    target_weight: normalizeNumber(ex?.target_weight, 0),
    target_reps: targetReps,
    weight_step: normalizeNumber(ex?.weight_step, 5),
    rest_seconds: restSeconds,
    cue: normalizeText(ex?.cue, libraryExercise.short_cue || "Use controlled form and stop if pain increases."),
    target_muscle: normalizeText(ex?.target_muscle, libraryExercise.target_muscle || "Main muscle"),
    coach_note: normalizeText(ex?.coach_note, "Included because it fits the weekly training focus."),
    image_url: libraryExercise.image_url || null,
    video_url: libraryExercise.video_url || null,
    image_path: libraryExercise.image_path || null,
    video_path: libraryExercise.video_path || null,
    guide_steps: Array.isArray(libraryExercise.guide_steps) ? libraryExercise.guide_steps : [],
    common_mistakes: Array.isArray(libraryExercise.common_mistakes) ? libraryExercise.common_mistakes : [],
    common_mistake: libraryExercise.common_mistake || null,
    pain_warning: libraryExercise.pain_warning || null,
    alternatives: Array.isArray(libraryExercise.alternatives) ? libraryExercise.alternatives : [],
    safe_alternative: libraryExercise.safe_alternative || null,
    usage_priority: libraryExercise.usage_priority || "medium",
    plan_ready: libraryExercise.plan_ready === true
  };
}

function sanitizeFoodItem(item) {
  const obj = safeObject(item);
  const type = normalizeText(obj.type, "food");

  if (type !== "food") return obj;

  const replacements = safeArray(obj.replacement_options)
    .map(v => normalizeText(v))
    .filter(Boolean)
    .slice(0, 2);

  return {
    time: normalizeText(obj.time, ""),
    title: normalizeText(obj.title, "Meal"),
    text: normalizeText(obj.text, "Protein-focused meal"),
    type: "food",
    estimated_protein_g: normalizeNumber(obj.estimated_protein_g, 0),
    prep_minutes: normalizeNumber(obj.prep_minutes, 0),
    work_friendly: obj.work_friendly === undefined ? true : Boolean(obj.work_friendly),
    ingredients: safeArray(obj.ingredients).slice(0, 12),
    replacement_options: replacements.length ? replacements : ["Similar home meal with protein", "Greek yogurt/curd or eggs if suitable"],
    coach_note: normalizeText(obj.coach_note, "Placed here to keep energy stable and protein consistent.")
  };
}

function sanitizeDailySchedule(dailySchedule) {
  const clean = {};

  for (const day of DAYS) {
    const items = safeArray(dailySchedule?.[day]).map(item => {
      const obj = safeObject(item);
      if (obj.type === "food") return sanitizeFoodItem(obj);
      return {
        ...obj,
        time: normalizeText(obj.time, ""),
        title: normalizeText(obj.title, obj.type === "gym" ? "Gym" : "Plan item"),
        text: normalizeText(obj.text, ""),
        type: normalizeText(obj.type, "note")
      };
    });

    clean[day] = items;
  }

  return clean;
}

function sanitizeWorkouts(workouts, exercises) {
  const lookup = buildExerciseLookup(exercises);
  const clean = {};

  for (const key of ["push", "legs", "pull", "mobility"]) {
    const items = safeArray(workouts?.[key])
      .map(ex => sanitizeExercise(ex, lookup, exercises, key))
      .filter(Boolean);

    clean[key] = items;
  }

  return clean;
}

function buildSafetyFlags(plan, userData) {
  const flags = [];
  const profile = userData.profile || {};
  const painLogs = safeArray(userData.pain_logs);

  const hasBackPain = JSON.stringify({ profile, painLogs }).toLowerCase().includes("back");
  if (hasBackPain) flags.push({ type: "back_safe", message: "Back-safe loading and controlled movement recommended." });

  const highPain = painLogs.some(log => normalizeNumber(log.pain_score || log.pain_rating || log.rating, 0) >= 5);
  if (highPain) flags.push({ type: "pain_5_plus", message: "Recent pain 5+ found. Avoid risky exercises and stop if pain increases." });

  const planText = JSON.stringify(plan).toLowerCase();
  if (planText.includes("deadlift") || planText.includes("back squat")) {
    flags.push({ type: "risky_loading_check", message: "Plan contains potentially risky loading. Confirm exercise library safety and user pain level." });
  }

  return flags;
}

function sanitizePlan(rawPlan, userData, entitlement) {
  const tier = planTierInfo(entitlement);
  const plan = safeObject(rawPlan);

  const clean = {
    title: normalizeText(plan.title, "FitApp Coach Plan"),
    plan_code: tier.code,
    generation_type: tier.generationType,
    start_date: normalizeText(plan.start_date, dateISO(0)),
    end_date: normalizeText(plan.end_date, dateISO(6)),
    summary: normalizeText(plan.summary, "Your weekly coach plan is ready."),
    coach_reasoning: normalizeText(plan.coach_reasoning, "This plan is based on your goals, schedule, food preferences, and recent logs."),
    safety_note: normalizeText(plan.safety_note, "Use controlled form. Stop any movement that causes sharp or increasing pain."),
    weekly_structure: safeArray(plan.weekly_structure),
    targets: safeArray(plan.targets).slice(0, 8),
    water_goal: {
      target_liters: normalizeNumber(plan.water_goal?.target_liters, userData.water_settings?.target_liters || 2),
      bottle_size_ml: normalizeNumber(plan.water_goal?.bottle_size_ml, userData.water_settings?.bottle_size_ml || 1000),
      bottles_per_day: normalizeNumber(plan.water_goal?.bottles_per_day, userData.water_settings?.bottles_per_day || 2),
      note: normalizeText(plan.water_goal?.note, "Sip consistently through the day.")
    },
    daily_schedule: sanitizeDailySchedule(plan.daily_schedule),
    workouts: sanitizeWorkouts(plan.workouts, userData.approved_exercise_library),
    meal_prep_plan: {
      prep_day: normalizeText(plan.meal_prep_plan?.prep_day, "Saturday"),
      fridge_items: safeArray(plan.meal_prep_plan?.fridge_items),
      freezer_items: safeArray(plan.meal_prep_plan?.freezer_items),
      fresh_items: safeArray(plan.meal_prep_plan?.fresh_items),
      packing_notes: safeArray(plan.meal_prep_plan?.packing_notes)
    },
    grocery_list: safeArray(plan.grocery_list),
    bloating_control: safeArray(plan.bloating_control),
    daily_checklist: safeArray(plan.daily_checklist),
    weekly_focus: safeArray(plan.weekly_focus),
    ai_adjustments: safeArray(plan.ai_adjustments),
    feature_locks: {
      pdf_export: tier.code === "free",
      progress_photos: tier.code === "free",
      smart_replacements: tier.code !== "premium_plus",
      ...(safeObject(plan.feature_locks))
    }
  };

  clean.safety_flags = buildSafetyFlags(clean, userData);

  return clean;
}

function validatePlan(plan) {
  if (!plan || typeof plan !== "object") {
    throw new Error("AI returned empty plan.");
  }

  if (!plan.daily_schedule || typeof plan.daily_schedule !== "object") {
    throw new Error("AI returned JSON, but daily_schedule is missing.");
  }

  if (!plan.workouts || typeof plan.workouts !== "object") {
    throw new Error("AI returned JSON, but workouts are missing.");
  }

  for (const day of DAYS) {
    if (!Array.isArray(plan.daily_schedule[day])) {
      throw new Error(`AI returned JSON, but ${day} schedule is missing.`);
    }
  }

  for (const key of ["push", "legs", "pull", "mobility"]) {
    if (!Array.isArray(plan.workouts[key])) {
      throw new Error(`AI returned JSON, but ${key} workout is missing.`);
    }
  }

  return true;
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: ""
    };
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, {
      ok: false,
      error: "Use POST from logged-in app."
    });
  }

  let aiRequestId = null;
  let db = null;

  try {
    const openaiKey = process.env.OPENAI_API_KEY;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!openaiKey) {
      return jsonResponse(500, {
        ok: false,
        error: "OPENAI_API_KEY missing in Netlify."
      });
    }

    if (!serviceRoleKey) {
      return jsonResponse(500, {
        ok: false,
        error: "SUPABASE_SERVICE_ROLE_KEY missing in Netlify."
      });
    }

    db = createClient(SUPABASE_URL, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });

    const user = await getUserFromToken(db, event);
    const userId = user.id;
    const admin = await isAdmin(db, userId);
    const entitlement = await ensureEntitlement(db, userId);
    const tier = planTierInfo(entitlement);
    const usageLimit = await readUsageLimit(db, tier.code);
    const monthlyUsed = await countMonthlyPlanGenerations(db, userId);
    const monthlyLimit = Number(usageLimit.weekly_plan_generations_per_month || 0);

    if (!admin && monthlyLimit > 0 && monthlyUsed >= monthlyLimit) {
      return jsonResponse(403, {
        ok: false,
        error: `${tier.label} plan allows ${monthlyLimit} AI plan generation${monthlyLimit === 1 ? "" : "s"} per month. You already used ${monthlyUsed}.`,
        code: "AI_LIMIT_REACHED",
        entitlement,
        usage: {
          monthly_used: monthlyUsed,
          monthly_limit: monthlyLimit
        }
      });
    }

    const userData = await readUserData(db, userId);

    if (!userData.profile || !userData.profile.onboarding_completed) {
      return jsonResponse(400, {
        ok: false,
        error: "Onboarding is not completed."
      });
    }

    if (!userData.approved_exercise_library.length) {
      return jsonResponse(400, {
        ok: false,
        error: "Exercise library is empty. Add exercises first before generating a workout plan."
      });
    }

    const usageInfo = {
      plan_code: tier.code,
      plan_name: tier.label,
      generation_type: tier.generationType,
      is_admin_bypass: admin,
      monthly_used: monthlyUsed,
      monthly_limit: monthlyLimit,
      remaining_this_month: admin ? "admin_bypass" : Math.max(0, monthlyLimit - monthlyUsed - 1),
      exercise_library_mode: userData.exercise_library_status?.mode || "unknown",
      plan_ready_exercises: userData.exercise_library_status?.plan_ready || 0,
      ai_exercises_available: userData.exercise_library_status?.used_for_ai || 0
    };

    const inputSummary = buildInputSummary(userData, entitlement, usageInfo);

    const aiRequestInsert = await db
      .from("ai_requests")
      .insert({
        user_id: userId,
        request_type: `weekly_plan_coach_${tier.generationType}`,
        status: "pending",
        model: MODEL,
        prompt_payload: {
          entitlement,
          usage: usageInfo,
          input_summary: inputSummary,
          user_data: userData
        }
      })
      .select()
      .single();

    if (aiRequestInsert.error) {
      throw aiRequestInsert.error;
    }

    aiRequestId = aiRequestInsert.data?.id || null;

    const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        input: buildPrompt(userData, entitlement, usageInfo),
        max_output_tokens: tier.maxOutputTokens
      })
    });

    const openaiData = await openaiResponse.json();

    if (!openaiResponse.ok) {
      if (aiRequestId) {
        await db
          .from("ai_requests")
          .update({
            status: "failed",
            error_message: JSON.stringify(openaiData)
          })
          .eq("id", aiRequestId);
      }

      return jsonResponse(openaiResponse.status, {
        ok: false,
        error: openaiData
      });
    }

    const outputText = getOutputText(openaiData);
    const parsed = extractJson(outputText);
    const rawPlan = parsed.next_week_plan || parsed;
    const plan = sanitizePlan(rawPlan, userData, entitlement);

    validatePlan(plan);

    const weekStart = plan.start_date || dateISO(0);
    const weekEnd = plan.end_date || dateISO(6);

    await db
      .from("weekly_plans")
      .update({ status: "archived" })
      .eq("user_id", userId)
      .eq("status", "active");

    const savedPlanRes = await db
      .from("weekly_plans")
      .insert({
        user_id: userId,
        week_start: weekStart,
        week_end: weekEnd,
        title: plan.title || "FitApp Coach Plan",
        status: "active",
        plan_json: plan,
        ai_summary: plan.summary || "",
        generated_by: "ai",
        is_premium_plan: tier.isPremium,
        plan_code: tier.code,
        generation_type: tier.generationType,
        entitlement_id: entitlement?.id || null,
        model_used: MODEL,
        input_summary: inputSummary,
        safety_flags: plan.safety_flags || []
      })
      .select()
      .single();

    if (savedPlanRes.error) {
      throw savedPlanRes.error;
    }

    if (aiRequestId) {
      await db
        .from("ai_requests")
        .update({
          status: "completed",
          response_payload: parsed,
          input_tokens: openaiData.usage?.input_tokens || null,
          output_tokens: openaiData.usage?.output_tokens || null
        })
        .eq("id", aiRequestId);
    }

    return jsonResponse(200, {
      ok: true,
      message: `${tier.label} coach plan generated and saved.`,
      plan_id: savedPlanRes.data.id,
      entitlement,
      usage: {
        monthly_used_before_request: monthlyUsed,
        monthly_limit: monthlyLimit,
        remaining_this_month: admin ? "admin_bypass" : Math.max(0, monthlyLimit - monthlyUsed - 1)
      },
      plan
    });

  } catch (error) {
    console.error(error);

    if (db && aiRequestId) {
      try {
        await db
          .from("ai_requests")
          .update({
            status: "failed",
            error_message: error.message || "Plan generation failed."
          })
          .eq("id", aiRequestId);
      } catch {
        // ignore logging failure
      }
    }

    return jsonResponse(error.statusCode || 500, {
      ok: false,
      error: error.message || "Plan generation failed."
    });
  }
}
