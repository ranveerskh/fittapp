import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://qusmbveovroldkhbjudq.supabase.co";
const MODEL = process.env.OPENAI_MODEL || "gpt-5.5";

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

function dateISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
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

async function readUserData(db, userId) {
  const [
    profileRes,
    foodRes,
    workRes,
    workoutRes,
    waterRes,
    measurementRes,
    dailyLogsRes,
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
      .limit(14),

    db.from("water_logs")
      .select("*")
      .eq("user_id", userId)
      .order("log_date", { ascending: false })
      .limit(14),

    db.from("workout_sessions")
      .select("*")
      .eq("user_id", userId)
      .order("workout_date", { ascending: false })
      .limit(10),

    db.from("exercise_logs")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(80),

    db.from("exercise_set_logs")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(120),

    db.from("pain_logs")
      .select("*")
      .eq("user_id", userId)
      .order("logged_at", { ascending: false })
      .limit(40),

    db.from("exercises")
      .select("id,name,slug,category,section,target_muscle,equipment,difficulty,image_url,video_url,short_cue,common_mistake,safe_alternative,back_safe,knee_safe,shoulder_safe")
      .order("category", { ascending: true }),

    db.from("weekly_plans")
      .select("id,title,week_start,week_end,status,plan_json,ai_summary,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(3)
  ]);

  const errors = [
    profileRes.error,
    foodRes.error,
    workRes.error,
    workoutRes.error,
    waterRes.error,
    measurementRes.error,
    dailyLogsRes.error,
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

  return {
    profile: profileRes.data,
    food_preferences: foodRes.data,
    work_schedule: workRes.data,
    workout_availability: workoutRes.data,
    water_settings: waterRes.data,
    measurements: measurementRes.data || [],
    daily_logs: dailyLogsRes.data || [],
    water_logs: waterLogsRes.data || [],
    workout_sessions: workoutSessionsRes.data || [],
    exercise_logs: exerciseLogsRes.data || [],
    exercise_set_logs: setLogsRes.data || [],
    pain_logs: painLogsRes.data || [],
    approved_exercise_library: exercisesRes.data || [],
    previous_plans: previousPlansRes.data || []
  };
}

function buildPrompt(userData) {
  return `
You are FitApp AI, a premium personal trainer and practical nutrition coach.

Your job:
Create a 7-day food + workout + water plan that feels like a real trainer made it.

This must NOT feel like a generic AI plan.

The plan should feel like a coach document:
- clear weekly structure
- exact foods
- exact meal times
- 1-2 replacements per meal
- smoothie/whey options if user allows
- workday meal timing
- gym/off-day meal timing
- grocery list
- meal prep system
- bloating control
- back-safe / pain-safe workout rules
- exact exercises, sets, reps, rest, cues
- trainer reasoning

PERSONALIZATION RULES:
- Use the user's real date of birth/age, measurements, goals, body type, work days, breaks, workout days, workout time, food styles, usual foods, favorite foods, disliked foods, allergies, avoid foods, smoothie preference, whey preference, protein preferences, carb preferences, meal prep style, bloating triggers, exercise preferences, pain areas, pain rating, exercise logs, and set logs.
- Allergies and avoid_foods are HARD BLOCKS. Never include those foods.
- Disliked foods should be avoided unless no other option exists.
- Favorite foods and usual foods should be used strongly.
- If user likes smoothies and uses whey, include smoothie and whey options.
- If user does not use whey, do not include whey.
- If user does not like smoothies, do not include smoothies.
- If user selected Punjabi/Indian/home food, meals should look like real home meals.
- If user prefers roti, rice, oats, wraps, bananas, dates, use those in the plan.
- If user has short work break, give fast snack only.
- If user has 30-minute break, give full packed meal.
- If job is heavy_active, walking, lifting, or user has high steps, do not add random cardio.
- If goal includes belly/reduce bloating, keep dinner lighter than lunch and include bloating control.
- If goal includes muscle/shape, include protein in every main meal.
- If user has pain rating 3-4 or 5+, reduce risky loading.
- If user has lower back pain, avoid ego deadlifts, heavy back-loaded squats, risky bending, and risky back extensions.
- Use back-safe options like machines, chest-supported row, leg press controlled, hip thrust machine, dead bug, Pallof press, face pulls, glute bridge.

WORKOUT RULES:
- Use ONLY approved_exercise_library for exercise names.
- Every workout must include warmup, main, and stretch sections.
- If approved_exercise_library is missing a perfect exercise, choose the closest safe exercise from that library.
- Never invent exercise names outside approved_exercise_library.
- Every exercise must include:
  name, section, planned_sets, sets, target_weight, target_reps, weight_step, rest_seconds, cue, target_muscle, coach_note.
- Workouts must match max_minutes.
- If user is beginner or some_experience, prefer machines, dumbbells, cables, controlled movements.
- If exercise_logs show hard effort or pain, keep same, reduce, or replace with safer alternative.
- If effort was easy and pain low, slightly increase reps or target weight.
- Most sets should stop with 1-2 reps left.
- Do not tell user to train to failure every set.

MEAL QUALITY RULES:
- Give exact meals, not vague “protein + carbs”.
- Include amounts when useful, like 2 roti, 3 roti, 300 ml milk, 1 scoop whey, 30g oats, 1 banana.
- Every food item must include replacement_options with 1-2 practical replacements.
- Each meal must include coach_note.
- Workday meals must be realistic for work breaks.
- Gym-day meals must include pre-workout and post-workout if workout time exists.
- If user allows whey, post-workout whey is allowed.
- If user likes smoothie, breakfast smoothie is allowed.
- If user prefers meal prep, include meal prep plan.
- If user has fridge_freezer_ok, include fridge/freezer strategy.

RETURN ONLY VALID JSON.
No markdown.
No comments.
No trailing commas.
No text outside JSON.

RETURN THIS EXACT JSON SHAPE:

{
  "next_week_plan": {
    "title": "FitApp Coach Plan",
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
    "ai_adjustments": []
  }
}

DAILY FOOD ITEM FORMAT:
{
  "time": "08:00",
  "title": "Breakfast",
  "text": "300 ml 2% milk smoothie with 1 banana, 1 scoop whey, 30g oats, 1 tbsp peanut butter, cinnamon",
  "type": "food",
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

USER DATA:
${JSON.stringify(userData, null, 2)}
`;
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

    const token = getBearerToken(event);

    if (!token) {
      return jsonResponse(401, {
        ok: false,
        error: "Missing Authorization Bearer token."
      });
    }

    const db = createClient(SUPABASE_URL, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });

    const { data: authData, error: authError } = await db.auth.getUser(token);

    if (authError || !authData.user) {
      return jsonResponse(401, {
        ok: false,
        error: "Invalid or expired user token."
      });
    }

    const userId = authData.user.id;
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

    const aiRequestInsert = await db
      .from("ai_requests")
      .insert({
        user_id: userId,
        request_type: "weekly_plan_coach_v3_preferences",
        status: "pending",
        model: MODEL,
        prompt_payload: userData
      })
      .select()
      .single();

    const aiRequestId = aiRequestInsert.data?.id || null;

    const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        input: buildPrompt(userData),
        max_output_tokens: 14000
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
    const plan = parsed.next_week_plan || parsed;

    if (!plan || !plan.daily_schedule || !plan.workouts) {
      throw new Error("AI returned JSON, but plan format is not valid.");
    }

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
        is_premium_plan: false
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
      message: "Coach-style weekly plan generated and saved.",
      plan_id: savedPlanRes.data.id,
      plan
    });

  } catch (error) {
    console.error(error);

    return jsonResponse(500, {
      ok: false,
      error: error.message || "Plan generation failed."
    });
  }
}