"use strict";

const ALLOWED_STYLES = new Set([
  "men",
  "women",
  "mixed"
]);

const ALLOWED_WORKOUTS = new Set([
  "push",
  "pull",
  "legs",
  "mobility",
  "recovery",
  "full-body",
  "cardio"
]);

function json(statusCode, body, extraHeaders = {}){
  return {
    statusCode,
    headers:{
      "Content-Type":"application/json; charset=utf-8",
      "Cache-Control":"public, max-age=3600, s-maxage=604800, stale-while-revalidate=2592000",
      "Access-Control-Allow-Origin":"*",
      "Access-Control-Allow-Methods":"GET,OPTIONS",
      "Access-Control-Allow-Headers":"Content-Type",
      ...extraHeaders
    },
    body:JSON.stringify(body)
  };
}

function isoWeekKey(date = new Date()){
  const value = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  ));

  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);

  const yearStart = new Date(
    Date.UTC(value.getUTCFullYear(),0,1)
  );

  const week = Math.ceil(
    (((value - yearStart) / 86400000) + 1) / 7
  );

  return `${value.getUTCFullYear()}-W${String(week).padStart(2,"0")}`;
}

function hashString(value){
  let hash = 2166136261;

  for(const character of String(value)){
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash,16777619);
  }

  return hash >>> 0;
}

function safeStyle(value){
  const style = String(value || "mixed").toLowerCase();
  return ALLOWED_STYLES.has(style)
    ? style
    : "mixed";
}

function safeWorkout(value){
  const workout = String(value || "mobility")
    .toLowerCase()
    .replace(/[_\s]+/g,"-");

  return ALLOWED_WORKOUTS.has(workout)
    ? workout
    : "mobility";
}

function personTerm(style){
  if(style === "men") return "man";
  if(style === "women") return "woman";
  return "men women";
}

function workoutTerm(workout){
  const terms = {
    "push":"chest shoulder strength workout gym",
    "pull":"back strength workout gym",
    "legs":"leg strength workout gym",
    "mobility":"stretching mobility recovery fitness",
    "recovery":"stretching mobility recovery fitness",
    "full-body":"full body strength training gym",
    "cardio":"cardio fitness training"
  };

  return terms[workout] || terms.mobility;
}

function buildQueries(style,workout){
  const person = personTerm(style);

  return {
    today:`${person} healthy fitness lifestyle training`,
    train:`${person} ${workoutTerm(workout)}`,
    meals:"healthy high protein meal preparation fitness food"
  };
}

async function unsplashFetch(path,accessKey){
  const response = await fetch(
    `https://api.unsplash.com${path}`,
    {
      headers:{
        "Accept-Version":"v1",
        "Authorization":`Client-ID ${accessKey}`
      }
    }
  );

  const result = await response
    .json()
    .catch(() => ({}));

  if(!response.ok){
    const detail = Array.isArray(result.errors)
      ? result.errors.join(" ")
      : "Unsplash request failed.";

    throw new Error(detail);
  }

  return result;
}

async function choosePhoto({
  query,
  slot,
  weekKey,
  style,
  workout,
  accessKey
}){
  const seed =
    hashString(
      `${weekKey}.${slot}.${style}.${workout}`
    );

  const page =
    1 + (seed % 3);

  const params = new URLSearchParams({
    query,
    page:String(page),
    per_page:"20",
    order_by:"relevant",
    orientation:"landscape",
    content_filter:"high"
  });

  const result = await unsplashFetch(
    `/search/photos?${params.toString()}`,
    accessKey
  );

  const photos =
    Array.isArray(result.results)
      ? result.results
      : [];

  if(!photos.length){
    throw new Error(
      `No Unsplash photo found for ${slot}.`
    );
  }

  const photo =
    photos[seed % photos.length];

  if(photo.links?.download_location){
    unsplashFetch(
      photo.links.download_location.replace(
        "https://api.unsplash.com",
        ""
      ),
      accessKey
    ).catch(() => {});
  }

  const imageBase =
    photo.urls?.regular ||
    photo.urls?.full ||
    photo.urls?.raw ||
    "";

  const joiner =
    imageBase.includes("?")
      ? "&"
      : "?";

  const tracking =
    "utm_source=shapecue&utm_medium=referral";

  return {
    id:photo.id,
    image_url:imageBase
      ? `${imageBase}${joiner}auto=format&fit=crop&w=1400&q=82`
      : "",
    thumb_url:photo.urls?.small || "",
    color:photo.color || "",
    blur_hash:photo.blur_hash || "",
    alt:
      photo.alt_description ||
      photo.description ||
      `${slot} fitness visual`,
    photographer_name:
      photo.user?.name ||
      photo.user?.username ||
      "Unsplash contributor",
    photographer_url:photo.user?.links?.html
      ? `${photo.user.links.html}?${tracking}`
      : `https://unsplash.com?${tracking}`,
    unsplash_url:photo.links?.html
      ? `${photo.links.html}?${tracking}`
      : `https://unsplash.com?${tracking}`,
    download_location:
      photo.links?.download_location ||
      ""
  };
}

exports.handler = async function handler(event){
  if(event.httpMethod === "OPTIONS"){
    return json(204,{});
  }

  if(event.httpMethod !== "GET"){
    return json(
      405,
      {
        ok:false,
        error:"Method not allowed."
      },
      {
        "Allow":"GET,OPTIONS"
      }
    );
  }

  const accessKey =
    process.env.UNSPLASH_ACCESS_KEY;

  if(!accessKey){
    return json(500,{
      ok:false,
      error:"UNSPLASH_ACCESS_KEY is not configured for Netlify Functions."
    });
  }

  const style =
    safeStyle(
      event.queryStringParameters?.style
    );

  const workout =
    safeWorkout(
      event.queryStringParameters?.workout
    );

  const weekKey =
    isoWeekKey();

  const queries =
    buildQueries(style,workout);

  try{
    const entries = await Promise.all(
      Object.entries(queries).map(
        async ([slot,query]) => [
          slot,
          await choosePhoto({
            query,
            slot,
            weekKey,
            style,
            workout,
            accessKey
          })
        ]
      )
    );

    return json(200,{
      ok:true,
      week_key:weekKey,
      style,
      workout,
      visuals:Object.fromEntries(entries)
    });
  }catch(error){
    console.error(
      "Weekly visual generation failed:",
      error
    );

    return json(502,{
      ok:false,
      error:
        error.message ||
        "Weekly visuals could not be loaded."
    });
  }
};
