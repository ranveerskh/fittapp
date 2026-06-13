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

const NEGATIVE_WORDS = [
  "snow", "winter", "hiking", "hike", "mountain", "trail",
  "outdoor", "outdoors", "street", "fashion", "coat", "jacket",
  "beach", "ski", "skiing"
];

function json(statusCode, body, extraHeaders = {}) {
  const success = statusCode >= 200 && statusCode < 300 && statusCode !== 204;

  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": success
        ? "public, max-age=3600, s-maxage=604800, stale-while-revalidate=2592000"
        : "no-store, max-age=0",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "X-ShapeCue-Visual-Version": "6",
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

function personWord(style) {
  if (style === "men") return "man";
  if (style === "women") return "woman";
  return "athlete";
}

function workoutQuery(workout) {
  const queries = {
    push: "chest workout gym",
    pull: "back workout gym",
    legs: "leg workout gym",
    mobility: "stretching fitness gym",
    recovery: "stretching recovery fitness",
    "full-body": "strength training gym",
    cardio: "cardio workout gym"
  };

  return queries[workout] || queries.mobility;
}

function buildSlotConfig(style, workout) {
  const person = personWord(style);
  const workoutBase = workoutQuery(workout);

  return {
    today: {
      searchQueries: [
        `${person} ${workoutBase}`,
        workoutBase,
        "fitness gym"
      ],
      randomQuery: workoutBase
    },
    train: {
      searchQueries: [
        `${person} ${workoutBase}`,
        workoutBase,
        "strength training gym"
      ],
      randomQuery: workoutBase
    },
    meals: {
      searchQueries: [
        "healthy high protein meal prep bowl",
        "healthy meal prep food",
        "healthy protein food"
      ],
      randomQuery: "healthy meal prep food"
    }
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
      : `Unsplash request failed (${response.status}).`;

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

  const slotWords = slot === "meals"
    ? ["food", "meal", "protein", "healthy", "prep", "vegetable", "bowl", "plate"]
    : ["gym", "fitness", "training", "workout", "strength", "weights"];

  const workoutWords = {
    push: ["chest", "bench", "press", "shoulder", "dumbbell"],
    pull: ["back", "row", "pulldown", "lat", "cable"],
    legs: ["leg", "legs", "squat", "lower body"],
    mobility: ["stretch", "stretching", "mobility"],
    recovery: ["stretch", "stretching", "recovery"],
    "full-body": ["strength", "weights", "training"],
    cardio: ["cardio", "bike", "treadmill", "cycling"]
  };

  for (const word of slotWords) {
    if (text.includes(word)) score += 3;
  }

  if (slot !== "meals") {
    for (const word of workoutWords[workout] || []) {
      if (text.includes(word)) score += 5;
    }

    for (const word of NEGATIVE_WORDS) {
      if (text.includes(word)) score -= 12;
    }
  } else {
    for (const word of ["gym", "workout", "athlete", "man", "woman", "portrait"]) {
      if (text.includes(word)) score -= 8;
    }
  }

  if (photo.width && photo.height && photo.width > photo.height) score += 2;
  if (photo.alt_description || photo.description) score += 1;
  if (Number(photo.likes || 0) > 100) score += 1;

  return score;
}

function buildImageUrl(photo) {
  const base = photo.urls?.raw || photo.urls?.full || photo.urls?.regular || "";
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
  } catch {
    return base;
  }
}

async function searchPhotos(query, accessKey) {
  const params = new URLSearchParams({
    query,
    page: "1",
    per_page: "30",
    order_by: "relevant",
    orientation: "landscape",
    content_filter: "high"
  });

  const result = await unsplashFetch(`/search/photos?${params.toString()}`, accessKey);
  return Array.isArray(result.results) ? result.results : [];
}

async function randomPhotos(query, accessKey) {
  const params = new URLSearchParams({
    query,
    orientation: "landscape",
    content_filter: "high",
    count: "10"
  });

  const result = await unsplashFetch(`/photos/random?${params.toString()}`, accessKey);
  return Array.isArray(result) ? result : (result?.id ? [result] : []);
}

async function getFallbackLandscapePhotos(accessKey) {
  const params = new URLSearchParams({
    orientation: "landscape",
    content_filter: "high",
    count: "10"
  });

  const result = await unsplashFetch(`/photos/random?${params.toString()}`, accessKey);
  return Array.isArray(result) ? result : (result?.id ? [result] : []);
}

async function triggerDownload(photo, accessKey) {
  if (!photo?.links?.download_location) return;

  const relativePath = photo.links.download_location.replace(
    "https://api.unsplash.com",
    ""
  );

  unsplashFetch(relativePath, accessKey).catch(() => {});
}

function serializePhoto(photo, slot, queryUsed, fallbackUsed) {
  const tracking = "utm_source=shapecue&utm_medium=referral";

  return {
    id: photo.id,
    image_url: buildImageUrl(photo),
    thumb_url: photo.urls?.small || "",
    color: photo.color || "",
    blur_hash: photo.blur_hash || "",
    width: photo.width || null,
    height: photo.height || null,
    query_used: queryUsed,
    fallback_used: fallbackUsed,
    alt:
      photo.alt_description ||
      photo.description ||
      `${slot} ShapeCue visual`,
    photographer_name:
      photo.user?.name ||
      photo.user?.username ||
      "Unsplash contributor",
    photographer_url: photo.user?.links?.html
      ? `${photo.user.links.html}?${tracking}`
      : `https://unsplash.com?${tracking}`,
    unsplash_url: photo.links?.html
      ? `${photo.links.html}?${tracking}`
      : `https://unsplash.com?${tracking}`,
    download_location: photo.links?.download_location || ""
  };
}

async function choosePhoto({
  slot,
  config,
  weekKey,
  style,
  workout,
  accessKey,
  excludedIds = new Set()
}) {
  const seed = hashString(`${weekKey}.${slot}.${style}.${workout}`);

  function selectUnique(photos, queryUsed, fallbackUsed) {
    const ranked = photos
      .map(photo => ({
        photo,
        score: scorePhoto(photo, slot, workout)
      }))
      .filter(item =>
        buildImageUrl(item.photo) &&
        item.photo?.id &&
        !excludedIds.has(item.photo.id)
      )
      .sort((a, b) => b.score - a.score);

    if (!ranked.length) return null;

    const bestScore = ranked[0].score;
    const shortlist = ranked
      .filter(item => item.score >= bestScore - 3)
      .slice(0, 8);

    const selected = shortlist[seed % shortlist.length]?.photo || ranked[0].photo;

    return {
      selected,
      queryUsed,
      fallbackUsed
    };
  }

  for (let index = 0; index < config.searchQueries.length; index += 1) {
    const query = config.searchQueries[index];
    const photos = await searchPhotos(query, accessKey);
    const result = selectUnique(
      photos,
      query,
      index === 0 ? "none" : "simpler-search"
    );

    if (result) {
      await triggerDownload(result.selected, accessKey);
      return serializePhoto(
        result.selected,
        slot,
        result.queryUsed,
        result.fallbackUsed
      );
    }
  }

  const randomCandidates = await randomPhotos(config.randomQuery, accessKey);
  const randomResult = selectUnique(
    randomCandidates,
    config.randomQuery,
    "random-query"
  );

  if (randomResult) {
    await triggerDownload(randomResult.selected, accessKey);
    return serializePhoto(
      randomResult.selected,
      slot,
      randomResult.queryUsed,
      randomResult.fallbackUsed
    );
  }

  const landscapeCandidates = await getFallbackLandscapePhotos(accessKey);
  const landscapeResult = selectUnique(
    landscapeCandidates,
    "random landscape",
    "random-landscape"
  );

  if (landscapeResult) {
    await triggerDownload(landscapeResult.selected, accessKey);
    return serializePhoto(
      landscapeResult.selected,
      slot,
      landscapeResult.queryUsed,
      landscapeResult.fallbackUsed
    );
  }

  throw new Error(`Unsplash returned no unique usable photo for ${slot}.`);
}

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return json(204, {});
  }

  if (event.httpMethod !== "GET") {
    return json(
      405,
      { ok: false, error: "Method not allowed." },
      { Allow: "GET,OPTIONS" }
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
  const slotConfig = buildSlotConfig(style, workout);

  try {
    const visuals = {};
    const selectedIds = new Set();

    // Resolve sequentially so a photo selected for one slot cannot be reused.
    for (const slot of ["today", "train", "meals"]) {
      const photo = await choosePhoto({
        slot,
        config: slotConfig[slot],
        weekKey,
        style,
        workout,
        accessKey,
        excludedIds: selectedIds
      });

      visuals[slot] = photo;
      selectedIds.add(photo.id);
    }

    const ids = Object.values(visuals).map(photo => photo.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error("Duplicate Unsplash photos were selected for different slots.");
    }

    return json(200, {
      ok: true,
      version: 6,
      week_key: weekKey,
      style,
      workout,
      visuals
    });
  } catch (error) {
    console.error("Weekly visual generation failed:", error);

    return json(502, {
      ok: false,
      version: 6,
      error: error.message || "Weekly visuals could not be loaded."
    });
  }
};
