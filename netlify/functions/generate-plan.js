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
    exercisesRes
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
      .order("category", { ascending: true })
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
    exercisesRes.error
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
    approved_exercise_library: exercisesRes.data || []
  };
}

function buildPrompt(userData) {
  return `
You are FitApp AI, a practical fitness planning engine.

Create a safe, simple, personalized 7-day food + workout + water plan.

CRITICAL RULES:
- Return ONLY valid JSON.
- No markdown.
- No comments.
- No trailing commas.
- This is general fitness/nutrition guidance, not medical advice.
- Do not diagnose medical conditions.
- Allergies and avoid_foods are HARD BLOCKS. Never include them.
- Use the user's selected food_styles, usual_foods, diet_type, work breaks, workout days, workout time, pain history, and max_minutes.
- Give exact foods, not vague advice.
- Every food item needs 1-2 replacement options.
- Keep meals realistic and short for phone display.
- Use only exercises from approved_exercise_library.
- Every workout must include warmup, main, and stretch sections.
- Every exercise must include planned_sets, target_weight, target_reps, weight_step, rest_seconds, cue.
- If user has pain history, reduce intensity or choose safer alternatives.
- For beginner users, prefer machines, dumbbells, cables, controlled movements.
- Do not add running/cardio unless user asked or it fits recovery. Active workers may not need extra cardio.
- Water target should be realistic and bottle-based.

RETURN THIS EXACT JSON SHAPE:

{
  "next_week_plan": {
    "title": "FitApp 7-Day Plan",
    "start_date": "${dateISO(0)}",
    "end_date": "${dateISO(6)}",
    "summary": "short summary",
    "safety_note": "short safety note",
    "water_goal": {
      "target_liters": 2,
      "bottle_size_ml": 1000,
      "bottles_per_day": 2
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
    "grocery_list": [],
    "weekly_focus": [],
    "ai_adjustments": []
  }
}

FOOD ITEM FORMAT:
{
  "time": "08:00",
  "title": "Breakfast",
  "text": "2 roti + paneer bhurji + cucumber salad",
  "type": "food",
  "replacement_options": [
    "Oats with whey/Greek yogurt if allowed + banana",
    "Tofu wrap + fruit"
  ]
}

GYM ITEM FORMAT:
{
  "time": "19:00",
  "title": "Gym: Push Day",
  "text": "Warm-up, chest/shoulders/triceps, stretches.",
  "type": "gym",
  "workout": "push"
}

WORKOUT EXERCISE FORMAT:
{
  "name": "Machine Chest Press",
  "section": "main",
  "planned_sets": 3,
  "sets": "3 x 10",
  "target_weight": 0,
  "target_reps": 10,
  "weight_step": 5,
  "rest_seconds": 90,
  "cue": "Chest up, shoulder blades back.",
  "target_muscle": "Chest"
}

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
        request_type: "weekly_plan",
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
        max_output_tokens: 9000
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
        title: plan.title || "FitApp 7-Day Plan",
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
      message: "Plan generated and saved.",
      plan_id: savedPlanRes.data.id,
      plan
    });

  } catch (error) {
    console.error(error);
    return jsonResponse(500, { ok: false, error: error.message || "Plan generation failed." });
  }
}