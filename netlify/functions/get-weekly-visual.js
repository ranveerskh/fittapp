from pathlib import Path
import re

html_path = Path("/mnt/data/test.html")
fn_path = Path("/mnt/data/get-weekly-visual.js")

html = html_path.read_text(encoding="utf-8")
fn = fn_path.read_text(encoding="utf-8")

# 1) Never cache function errors. Only successful image payloads get weekly CDN caching.
old_json = '''function json(statusCode, body, extraHeaders = {}) {
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
}'''

new_json = '''function json(statusCode, body, extraHeaders = {}) {
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
      "X-ShapeCue-Visual-Version": "3",
      ...extraHeaders
    },
    body: JSON.stringify(body)
  };
}'''

if old_json not in fn:
    raise RuntimeError("Could not find json helper in function file.")
fn = fn.replace(old_json, new_json)

# 2) New client cache version to bypass any cached failed v2 response.
html = html.replace(
    'const VISUAL_CACHE_PREFIX = "shapecue.visual_test.weekly.v2.";',
    'const VISUAL_CACHE_PREFIX = "shapecue.visual_test.weekly.v3.";'
)

# 3) Cached payload must contain actual image URLs, not merely a visuals object.
old_cache_check = '''    if(
      !parsed?.visuals ||
      !parsed?.week_key
    ){
      return null;
    }

    return parsed;'''

new_cache_check = '''    const visuals = parsed?.visuals;
    const valid =
      parsed?.week_key &&
      visuals?.today?.image_url &&
      visuals?.train?.image_url &&
      visuals?.meals?.image_url;

    if(!valid){
      localStorage.removeItem(key);
      return null;
    }

    return parsed;'''

if old_cache_check not in html:
    raise RuntimeError("Could not find visual cache validation.")
html = html.replace(old_cache_check, new_cache_check)

# 4) Remove strict URL equality test. Browsers normalize Unsplash URLs, which can prevent reveal.
start = html.index('function applyPhotoToCover({')
end = html.index('\nfunction applyMinimalVisualMode()', start)

new_apply = r'''function applyPhotoToCover({
  coverId,
  imageId,
  creditId,
  visual,
  alt
}){
  const cover = $("#" + coverId);
  const image = $("#" + imageId);
  const credit = $("#" + creditId);

  if(!cover || !image || !credit) return;

  cover.classList.remove("visual-ready","visual-minimal");

  if(!visual?.image_url){
    cover.classList.remove("visual-loading");
    image.removeAttribute("src");
    image.alt = "";
    credit.hidden = true;
    if(coverId === "todayCoachCover") restartPulseStrip(true);
    return;
  }

  const expectedSrc = String(visual.image_url);
  const preload = new Image();

  const reveal = () => {
    image.src = expectedSrc;
    image.alt = alt || visual.alt || "";
    cover.classList.remove("visual-loading","visual-minimal");
    cover.classList.add("visual-ready");

    credit.textContent =
      `Photo by ${visual.photographer_name || "Unsplash contributor"} on Unsplash`;

    credit.href =
      visual.photographer_url ||
      visual.unsplash_url ||
      "https://unsplash.com";

    credit.hidden = false;

    if(coverId === "todayCoachCover") restartPulseStrip(true);
  };

  const fail = () => {
    console.error("ShapeCue visual image failed:", expectedSrc);
    cover.classList.remove("visual-loading","visual-ready");
    cover.classList.add("visual-minimal");
    image.removeAttribute("src");
    credit.hidden = true;
    if(coverId === "todayCoachCover") restartPulseStrip(true);
  };

  preload.onload = reveal;
  preload.onerror = fail;
  preload.src = expectedSrc;

  if(preload.complete && preload.naturalWidth > 0){
    requestAnimationFrame(reveal);
  }
}
'''

html = html[:start] + new_apply + html[end:]

# 5) Use a fresh endpoint version and bypass failed CDN cache on manual force refresh.
old_params = '''    const params = new URLSearchParams({
      style,
      workout,
      week:isoWeekKey(),
      v:"2"
    });'''

new_params = '''    const params = new URLSearchParams({
      style,
      workout,
      week:isoWeekKey(),
      v:"3"
    });

    if(force){
      params.set("refresh", String(Date.now()));
    }'''

if old_params not in html:
    raise RuntimeError("Could not find visual request parameters.")
html = html.replace(old_params, new_params)

# 6) Provide the actual server error to the user instead of only a generic gradient message.
html = html.replace(
'''    toast(
      "Visual service unavailable. Gradient preview is showing."
    );''',
'''    toast(
      `Visual error: ${error.message || "service unavailable"}`
    );'''
)

# 7) Add an explicit response validation in case the server returned an HTML 404 page.
old_result = '''    const result = await response
      .json()
      .catch(() => ({}));

    if(!response.ok || result.ok === false){
      throw new Error(
        result.error ||
        "Weekly visuals could not be loaded."
      );
    }'''

new_result = '''    const responseText = await response.text();
    let result = {};

    try{
      result = JSON.parse(responseText);
    }catch{
      throw new Error(
        response.status === 404
          ? "Netlify function was not found. Check netlify/functions/get-weekly-visual.js and redeploy."
          : `Visual function returned non-JSON (${response.status}).`
      );
    }

    if(!response.ok || result.ok === false){
      throw new Error(
        result.error ||
        `Weekly visuals could not be loaded (${response.status}).`
      );
    }

    if(
      !result?.visuals?.today?.image_url ||
      !result?.visuals?.train?.image_url ||
      !result?.visuals?.meals?.image_url
    ){
      throw new Error("Visual function returned no image URLs.");
    }'''

if old_result not in html:
    raise RuntimeError("Could not find visual response parser.")
html = html.replace(old_result, new_result)

# Save v3 files.
Path("/mnt/data/test-v3.html").write_text(html, encoding="utf-8")
Path("/mnt/data/test-v3.txt").write_text(html, encoding="utf-8")
Path("/mnt/data/get-weekly-visual-v3.js").write_text(fn, encoding="utf-8")
Path("/mnt/data/get-weekly-visual-v3.txt").write_text(fn, encoding="utf-8")

print("Created fixed v3 files.")
