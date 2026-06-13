"use strict";

const STYLE_ALIASES = new Map([
  ["automatic", "mixed"],
  ["auto", "mixed"],
  ["men", "men"],
  ["man", "men"],
  ["male", "men"],
  ["women", "women"],
  ["woman", "women"],
  ["female", "women"],
  ["mixed", "mixed"]
]);

const WORKOUT_ALIASES = new Map([
  ["push", "push"],
  ["pull", "pull"],
  ["legs", "legs"],
  ["leg", "legs"],
  ["mobility", "mobility"],
  ["recovery", "recovery"],
  ["full-body", "full-body"],
  ["fullbody", "full-body"],
  ["cardio", "cardio"]
]);

const NEGATIVE_WORDS = new Set([
  "snow",
  "winter",
  "hiking",
  "hike",
  "mountain",
  "mountains",
  "trail",
  "outdoor",
  "outdoors",
  "street",
  "fashion",
  "coat",
  "jacket",
  "beach",
  "ski",
  "skiing",
  "portrait"
]);

const SLOT_POSITIVE_WORDS = {
  today: ["gym", "fitness", "training", "workout", "strength", "weights"],
  train: ["gym", "fitness", "training", "workout", "strength", "weights"],
  meals: ["food", "meal", "protein", "healthy", "nutrition", "prep"]
};

const WORKOUT_POSITIVE_WORDS = {
  push: ["chest", "bench", "press", "shoulder", "dumbbell"],
  pull: ["back", "row", "pulldown", "lat", "cable"],
  legs: ["leg", "legs", "squat", "lower", "body"],
  mobility: ["stretch", "stretching", "mobility", "recovery"],
  recovery: ["stretch", "stretching", "mobility", "recovery"],
  "full-body": ["strength", "weights", "training", "gym"],
  cardio: ["cardio", "bike", "cycling", "treadmill", "fitness"]
};

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=604800, stale-while-revalidate=2592000",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      ...extraHeaders
    },
    body: JSON.stringify(body)
  };
}

function isoWeekKey(date = new Date()) {
  const value = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  ));

  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);

  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((value - yearStart) / 86400000) + 1) / 7);

  return `${value.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function safeWeekKey(value) {
  const candidate = String(value || "").trim().toUpperCase();
  return /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(candidate)
    ? candidate
    : isoWeekKey();
}

function hashString(value) {
  let hash = 2166136261;

  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function safeStyle(value) {
  return STYLE_ALIASES.get(String(value || "automatic").toLowerCase()) || "mixed";
}

function safeWorkout(value) {
  const normalized = String(value || "mobility")
    .toLowerCase()
    .trim()
    .replace(/[_\s]+/g, "-");

  return WORKOUT_ALIASES.get(normalized) || "mobility";
}

function personTerm(style) {
  if (style === "men") return "male athlete";
  if (style === "women") return "female athlete";
  return "athlete";
}

function workoutTerm(workout) {
  const terms = {
    push: "chest press shoulder strength workout gym weights",
    pull: "back workout gym cable row lat pulldown weights",
    legs: "leg workout gym squat lower body strength weights",
    mobility: "athlete stretching mobility recovery indoor fitness",
    recovery: "athlete stretching recovery indoor fitness",
    "full-body": "full body strength training gym weights",
    cardio: "indoor cardio fitness training gym"
  };

  return terms[workout] || terms.mobility;
}

function buildQueries(style, workout) {
  const person = personTerm(style);
  const workoutQuery = `${person} ${workoutTerm(workout)}`;

  return {
    today: workoutQuery,
    train: workoutQuery,
    meals: "healthy high protein meal prep fitness food"
  };
}

async function unsplashFetch(path, accessKey) {
  const response = await fetch(`https://api.unsplash.com${path}`, {
    headers: {
      "Accept-Version": "v1",
      "Authorization": `Client-ID ${accessKey}`
    }
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = Array.isArray(result.errors)
      ? result.errors.join(" ")
      : "Unsplash request failed.";

    throw new Error(detail);
  }

  return result;
}

function searchableText(photo) {
  return [
    photo.alt_description,
    photo.description,
    photo.user?.bio,
    photo.user?.name
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function scorePhoto(photo, slot, workout) {
  const text = searchableText(photo);
  let score = 0;

  for (const word of SLOT_POSITIVE_WORDS[slot] || []) {
    if (text.includes(word)) score += 3;
  }

  if (slot !== "meals") {
    for (const word of WORKOUT_POSITIVE_WORDS[workout] || []) {
      if (text.includes(word)) score += 5;
    }

    for (const word of NEGATIVE_WORDS) {
      if (text.includes(word)) score -= 8;
    }

    if (photo.width && photo.height && photo.width > photo.height) score += 2;
  } else {
    if (text.includes("gym") || text.includes("workout")) score -= 2;
  }

  if (photo.likes > 100) score += 1;
  if (photo.alt_description || photo.description) score += 1;

  return score;
}

function buildImageUrl(photo) {
  const base =
    photo.urls?.raw ||
    photo.urls?.full ||
    photo.urls?.regular ||
    "";

  if (!base) return "";

  try {
    const url = new URL(base);
    url.searchParams.set("auto", "format");
    url.searchParams.set("fit", "crop");
    url.searchParams.set("crop", "faces,entropy");
    url.searchParams.set("w", "1400");
    url.searchParams.set("h", "820");
    url.searchParams.set("q", "82");
    return url.toString();
  } catch (_) {
    return base;
  }
}

async function choosePhoto({
  query,
  slot,
  weekKey,
  style,
  workout,
  accessKey
}) {
  const seed = hashString(`${weekKey}.${slot}.${style}.${workout}`);
  const page = 1 + (seed % 2);

  const params = new URLSearchParams({
    query,
    page: String(page),
    per_page: "30",
    order_by: "relevant",
    orientation: "landscape",
    content_filter: "high"
  });

  const result = await unsplashFetch(
    `/search/photos?${params.toString()}`,
    accessKey
  );

  const photos = Array.isArray(result.results) ? result.results : [];

  if (!photos.length) {
    throw new Error(`No Unsplash photo found for ${slot}.`);
  }

  const ranked = photos
    .map(photo => ({
      photo,
      score: scorePhoto(photo, slot, workout)
    }))
    .sort((a, b) => b.score - a.score);

  const bestScore = ranked[0]?.score ?? 0;
  const shortlist = ranked
    .filter(item => item.score >= bestScore - 3)
    .slice(0, 8);

  const selected = shortlist[seed % shortlist.length]?.photo || ranked[0].photo;

  if (selected.links?.download_location) {
    unsplashFetch(
      selected.links.download_location.replace("https://api.unsplash.com", ""),
      accessKey
    ).catch(() => {});
  }

  const tracking = "utm_source=shapecue&utm_medium=referral";

  return {
    id: selected.id,
    image_url: buildImageUrl(selected),
    thumb_url: selected.urls?.small || "",
    color: selected.color || "",
    blur_hash: selected.blur_hash || "",
    width: selected.width || null,
    height: selected.height || null,
    query_used: query,
    alt:
      selected.alt_description ||
      selected.description ||
      `${slot} fitness visual`,
    photographer_name:
      selected.user?.name ||
      selected.user?.username ||
      "Unsplash contributor",
    photographer_url: selected.user?.links?.html
      ? `${selected.user.links.html}?${tracking}`
      : `https://unsplash.com?${tracking}`,
    unsplash_url: selected.links?.html
      ? `${selected.links.html}?${tracking}`
      : `https://unsplash.com?${tracking}`,
    download_location: selected.links?.download_location || ""
  };
}

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return json(204, {});
  }

  if (event.httpMethod !== "GET") {
    return json(
      405,
      {
        ok: false,
        error: "Method not allowed."
      },
      {
        "Allow": "GET,OPTIONS"
      }
    );
  }

  const accessKey = process.env.UNSPLASH_ACCESS_KEY;

  if (!accessKey) {
    return json(500, {
      ok: false,
      error: "UNSPLASH_ACCESS_KEY is not configured for Netlify Functions."
    });
  }

  const style = safeStyle(event.queryStringParameters?.style);
  const workout = safeWorkout(event.queryStringParameters?.workout);
  const weekKey = safeWeekKey(event.queryStringParameters?.week);
  const queries = buildQueries(style, workout);

  try {
    const entries = await Promise.all(
      Object.entries(queries).map(async ([slot, query]) => [
        slot,
        await choosePhoto({
          query,
          slot,
          weekKey,
          style,
          workout,
          accessKey
        })
      ])
    );

    return json(200, {
      ok: true,
      week_key: weekKey,
      style,
      workout,
      visuals: Object.fromEntries(entries)
    });
  } catch (error) {
    console.error("Weekly visual generation failed:", error);

    return json(502, {
      ok: false,
      error: error.message || "Weekly visuals could not be loaded."
    });
  }
};
