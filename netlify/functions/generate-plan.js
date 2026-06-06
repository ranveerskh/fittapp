import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://qusmbveovroldkhbjudq.supabase.co";
const MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
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
      .limit(30),

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

  if (errors.length) throw new Error(errors[0].message || "Could not read user data.");

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
You are FitApp AI, a premium personal trainer + practical nutrition coach.

Your job:
Create a 7-day plan that feels like a real coach made it, not a generic AI app.

STYLE STANDARD:
The plan should feel like a personalized trainer document:
- clear weekly structure
- clear goal reasoning
- workday meal timing
- gym/off-day meal timing
- exact foods
- 1-2 replacements per meal
- workout focus notes
- safe exercise choices
- pain/back-safe rules when needed
- meal prep plan
- grocery list
- bloating/stomach control
- simple daily checklist logic

PERSONALIZATION RULES:
- Do NOT create a generic plan.
- Use the user's real work days, workout days, breaks, workout time, max gym time, food styles, usual foods, allergies, avoid foods, measurements, pain logs, and exercise logs.
- If the user has a heavy/active job, do not add random cardio.
- If the user has back pain or pain logs, avoid ego deadlifts, heavy back-loading, risky bending, and risky spinal loading.
- If the user works many steps/lifting, carbs are allowed around work and gym.
- If goal includes belly/bloating, keep dinner lighter than lunch and avoid late heavy/fried meals.
- If goal includes muscle/shape, protein must appear in every main meal.
- Use foods the user actually eats. If usual_foods exists, use it strongly.
- Allergies and avoid_foods are hard blocks.
- If user selected Punjabi/Indian/home food, meals should look like real Punjabi/Indian home meals, not random western fitness meals.
- If diet allows eggs/chicken, use them only according to diet_type and usual foods.
- If vegetarian, do not include eggs/chicken unless diet_type says eggs_ok/chicken_ok.
- Work break foods must match break duration and full_meal possibility.
- If there is only a short break, give quick snack only.
- If there is a 30-minute break, give packed meal.
- Give exact meal examples, not vague "protein + carbs".
- Give replacements that are equally practical.

WORKOUT RULES:
- Use only approved_exercise_library.
- Every workout must include warmup, main, and stretch sections.
- Every exercise must include:
  name, section, planned_sets, sets, target_weight, target_reps, weight_step, rest_seconds, cue, target_muscle.
- Workouts should match available max_minutes.
- If user is beginner/some_experience, prefer machines, dumbbells, cables, controlled form.
- For back pain, prefer chest-supported rows, machines, hip thrust machine, leg press controlled, dead bug, Pallof press, face pulls.
- Avoid risky lower-back loading unless pain history is clean.
- If exercise_logs show hard effort or pain, keep/reduce weight or choose safer alternative.
- If effort was easy and pain low, slightly increase reps or target weight.
- Most sets should stop with 1-2 reps left. Do not tell user to train to failure every set.

COACHING QUALITY:
- Add "coach_reasoning" explaining why this plan fits the user.
- Add "weekly_structure" explaining the day-by-day logic.
- Add "meal_prep_plan" for busy/workdays.
- Add "bloating_control" if goal or food notes suggest belly/bloating.
- Add "daily_checklist" with simple yes/no items.
- Keep text compact enough for mobile cards.

RETURN ONLY VALID JSON.
No markdown.
No comments.
No trailing commas.

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

FOOD ITEM FORMAT:
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

IMPORTANT:
- Daily schedule must include exact foods with amounts where possible.
- Every food item must include replacement_options.
- Add gym item on workout days.
- Add mobility or recovery item on active workdays if useful.
- Grocery list should be practical, grouped as strings.
- Do not include foods from allergies or avoid_foods.
- Do not include exercises outside approved_exercise_library.

USER DATA:
${JSON.stringify(userData, null, 2)}
`;
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "Use POST from logged-in app." });
  }

  try {
    const openaiKey = process.env.OPENAI_API_KEY;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!openaiKey) return jsonResponse(500, { ok: false, error: "OPENAI_API_KEY missing in Netlify." });
    if (!serviceRoleKey) return jsonResponse(500, { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY missing in Netlify." });

    const token = getBearerToken(event);
    if (!token) return jsonResponse(401, { ok: false, error: "Missing Authorization Bearer token." });

    const db = createClient(SUPABASE_URL, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const { data: authData, error: authError } = await db.auth.getUser(token);

    if (authError || !authData.user) {
      return jsonResponse(401, { ok: false, error: "Invalid or expired user token." });
    }

    const userId = authData.user.id;
    const userData = await readUserData(db, userId);

    if (!userData.profile || !userData.profile.onboarding_completed) {
      return jsonResponse(400, { ok: false, error: "Onboarding is not completed." });
    }

    const aiRequestInsert = await db
      .from("ai_requests")
      .insert({
        user_id: userId,
        request_type: "weekly_plan_coach_v2",
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
        max_output_tokens: 12000
      })
    });

    const openaiData = await openaiResponse.json();

    if (!openaiResponse.ok) {
      if (aiRequestId) {
        await db.from("ai_requests").update({
          status: "failed",
          error_message: JSON.stringify(openaiData)
        }).eq("id", aiRequestId);
      }

      return jsonResponse(openaiResponse.status, { ok: false, error: openaiData });
    }

    const outputText = getOutputText(openaiData);
    const parsed = extractJson(outputText);
    const plan = parsed.next_week_plan || parsed;

    if (!plan || !plan.daily_schedule || !plan.workouts) {
      throw new Error("AI returned JSON, but plan format is not valid.");
    }

    const weekStart = plan.start_date || dateISO(0);
    const weekEnd = plan.end_date || dateISO(6);

    await db.from("weekly_plans")
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

    if (savedPlanRes.error) throw savedPlanRes.error;

    if (aiRequestId) {
      await db.from("ai_requests").update({
        status: "completed",
        response_payload: parsed,
        input_tokens: openaiData.usage?.input_tokens || null,
        output_tokens: openaiData.usage?.output_tokens || null
      }).eq("id", aiRequestId);
    }

    return jsonResponse(200, {
      ok: true,
      message: "Coach-style plan generated and saved.",
      plan_id: savedPlanRes.data.id,
      plan
    });

  } catch (error) {
    console.error(error);
    return jsonResponse(500, { ok: false, error: error.message || "Plan generation failed." });
  }
}