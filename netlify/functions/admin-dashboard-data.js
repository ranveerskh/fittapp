import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://qusmbveovroldkhbjudq.supabase.co";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, OPTIONS"
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
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function normalizePlanCode(code) {
  const value = String(code || "free").toLowerCase();
  if (["coach", "premium_plus", "premium_plus_weekly", "coach_weekly"].includes(value)) return "coach";
  if (["premium", "premium_biweekly", "premium_every_14_days"].includes(value)) return "premium";
  if (["plus", "premium_monthly", "plus_monthly"].includes(value)) return "plus";
  return "free";
}

function planName(code) {
  const normalized = normalizePlanCode(code);
  if (normalized === "coach") return "Coach";
  if (normalized === "premium") return "Premium";
  if (normalized === "plus") return "Plus";
  return "Free";
}

function requestSource(row) {
  const access = row?.prompt_payload?.access || {};
  return access.request_source || row?.prompt_payload?.request_source || null;
}

function friendlySource(source) {
  const value = String(source || "").toLowerCase();
  if (value === "first_plan") return "First plan";
  if (value === "admin_manual") return "Admin update";
  if (value === "addon_credit") return "Extra update";
  if (value === "scheduled_auto") return "Automatic update";
  return source || "Unknown";
}

async function requireAdmin(db, event) {
  const token = getBearerToken(event);
  if (!token) {
    const error = new Error("Missing Authorization Bearer token.");
    error.statusCode = 401;
    throw error;
  }

  const { data: authData, error: authError } = await db.auth.getUser(token);
  if (authError || !authData?.user) {
    const error = new Error("Invalid or expired user token.");
    error.statusCode = 401;
    throw error;
  }

  const user = authData.user;
  const { data: admin, error: adminError } = await db
    .from("app_admins")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (adminError) throw adminError;
  if (!admin) {
    const error = new Error("Admin access required.");
    error.statusCode = 403;
    throw error;
  }

  return {
    user,
    admin: {
      id: admin.id || null,
      user_id: user.id,
      role: admin.role || "Admin"
    }
  };
}

async function safeRows(promise, fallback = []) {
  const result = await promise;
  if (result.error) {
    console.warn("Optional admin query failed:", result.error.message);
    return fallback;
  }
  return result.data ?? fallback;
}

async function safeCount(promise) {
  const result = await promise;
  if (result.error) {
    console.warn("Optional count failed:", result.error.message);
    return 0;
  }
  return Number(result.count || 0);
}

async function loadCurrentEntitlements(db, userIds = null) {
  let currentQuery = db.from("current_user_entitlements").select("*");
  if (Array.isArray(userIds) && userIds.length) {
    currentQuery = currentQuery.in("user_id", userIds);
  }

  const currentResult = await currentQuery;
  if (!currentResult.error) {
    return currentResult.data || [];
  }

  console.warn(
    "current_user_entitlements unavailable; using active entitlement fallback:",
    currentResult.error.message
  );

  let fallbackQuery = db.from("user_entitlements").select("*");
  if (Array.isArray(userIds) && userIds.length) {
    fallbackQuery = fallbackQuery.in("user_id", userIds);
  }

  const rows = await safeRows(fallbackQuery, []);
  const now = Date.now();
  const activeRows = rows.filter(row => {
    const status = String(row.status || "active").toLowerCase();
    const notExpired = !row.ends_at || new Date(row.ends_at).getTime() > now;
    return ["active", "trialing"].includes(status) && notExpired;
  });

  return [...latestByUser(activeRows).values()];
}

function latestByUser(rows, userKey = "user_id", dateKeys = ["updated_at", "created_at"]) {
  const map = new Map();
  for (const row of rows || []) {
    const userId = row?.[userKey];
    if (!userId) continue;
    const current = map.get(userId);
    const rowTime = dateKeys.reduce((value, key) => value || row?.[key], null);
    const currentTime = dateKeys.reduce((value, key) => value || current?.[key], null);
    if (!current || new Date(rowTime || 0) >= new Date(currentTime || 0)) {
      map.set(userId, row);
    }
  }
  return map;
}

function userDisplayName(authUser, profile) {
  return profile?.full_name ||
    authUser?.user_metadata?.full_name ||
    authUser?.user_metadata?.name ||
    authUser?.email?.split("@")[0] ||
    "ShapeCue user";
}

function mapAiRequest(row) {
  const source = requestSource(row);
  const payload = row?.response_payload || {};
  const access = row?.prompt_payload?.access || {};
  return {
    id: row.id,
    user_id: row.user_id,
    request_type: row.request_type,
    request_source: source,
    request_source_label: friendlySource(source),
    status: row.status || "pending",
    model: row.model || null,
    error_message: row.error_message || null,
    input_tokens: row.input_tokens || null,
    output_tokens: row.output_tokens || null,
    plan_id: payload.plan_id || null,
    credit_consumed: Boolean(access.credit_consumed),
    credit_refunded: Boolean(access.credit_refunded),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    completed_at: row.completed_at || payload.completed_at || null
  };
}

async function loadOverview(db) {
  const startToday = new Date();
  startToday.setUTCHours(0, 0, 0, 0);
  const nowIso = new Date().toISOString();

  const [authUsersResult, entitlements, jobsToday, failedRecent, processingNow, profiles, recentRows] = await Promise.all([
    db.auth.admin.listUsers({ page: 1, perPage: 1 }),
    loadCurrentEntitlements(db),
    safeCount(db.from("ai_requests").select("id", { count: "exact", head: true }).gte("created_at", startToday.toISOString())),
    safeCount(db.from("ai_requests").select("id", { count: "exact", head: true }).eq("status", "failed").gte("created_at", new Date(Date.now() - 7 * 86400000).toISOString())),
    safeCount(db.from("ai_requests").select("id", { count: "exact", head: true }).in("status", ["pending", "processing"])),
    safeRows(db.from("profiles").select("*")),
    safeRows(db.from("ai_requests").select("*").order("created_at", { ascending: false }).limit(8))
  ]);

  const totalUsers = Number(authUsersResult?.data?.total || authUsersResult?.data?.users?.length || 0);
  const latestEntitlements = latestByUser(entitlements);
  let paidMembers = 0;
  for (const entitlement of latestEntitlements.values()) {
    const code = normalizePlanCode(entitlement.plan_code);
    const status = String(entitlement.status || "active").toLowerCase();
    const notExpired = !entitlement.ends_at || new Date(entitlement.ends_at) > new Date();
    if (code !== "free" && ["active", "trialing"].includes(status) && notExpired) paidMembers += 1;
  }

  const dueUpdates = profiles.filter(profile => {
    if (!profile.next_plan_update_at) return false;
    const status = String(profile.auto_plan_update_status || "").toLowerCase();
    return new Date(profile.next_plan_update_at) <= new Date(nowIso) && !["processing", "queued"].includes(status);
  }).length;

  const retrying = profiles.filter(profile =>
    ["dispatch_retry", "retry_scheduled", "failed"].includes(String(profile.auto_plan_update_status || "").toLowerCase())
  ).length;

  return {
    stats: {
      total_users: totalUsers,
      paid_members: paidMembers,
      ai_jobs_today: jobsToday,
      requires_attention: failedRecent + retrying,
      queued_or_processing: processingNow,
      updates_due: dueUpdates,
      retries_waiting: retrying
    },
    recent_activity: recentRows.map(mapAiRequest),
    generated_at: nowIso
  };
}

async function loadUsers(db, params) {
  const page = Math.max(1, Number(params.get("page") || 1));
  const perPage = Math.max(10, Math.min(100, Number(params.get("per_page") || 50)));
  const search = String(params.get("search") || "").trim().toLowerCase();
  const planFilter = normalizePlanCode(params.get("plan"));
  const hasPlanFilter = params.has("plan") && String(params.get("plan") || "").toLowerCase() !== "all";
  const attentionOnly = params.get("attention") === "true";

  const authResult = await db.auth.admin.listUsers({ page, perPage });
  if (authResult.error) throw authResult.error;

  let authUsers = authResult.data?.users || [];
  const ids = authUsers.map(user => user.id);

  if (!ids.length) {
    return { users: [], page, per_page: perPage, total: Number(authResult.data?.total || 0) };
  }

  const [profiles, entitlements, wallets, aiRows, planRows] = await Promise.all([
    safeRows(db.from("profiles").select("*").in("id", ids)),
    loadCurrentEntitlements(db, ids),
    safeRows(db.from("ai_update_wallets").select("*").in("user_id", ids)),
    safeRows(db.from("ai_requests").select("*").in("user_id", ids).order("created_at", { ascending: false })),
    safeRows(db.from("weekly_plans").select("id,user_id,status,created_at,week_start,week_end,title").in("user_id", ids).order("created_at", { ascending: false }))
  ]);

  const profileMap = new Map(profiles.map(row => [row.id, row]));
  const entitlementMap = latestByUser(entitlements);
  const walletMap = new Map(wallets.map(row => [row.user_id, row]));
  const aiMap = latestByUser(aiRows);
  const planMap = latestByUser(planRows);

  let users = authUsers.map(authUser => {
    const profile = profileMap.get(authUser.id) || {};
    const entitlement = entitlementMap.get(authUser.id) || {};
    const latestAi = aiMap.get(authUser.id) || null;
    const latestPlan = planMap.get(authUser.id) || null;
    const wallet = walletMap.get(authUser.id) || {};
    const planCode = normalizePlanCode(entitlement.plan_code || profile.selected_plan_code);
    const autoStatus = profile.auto_plan_update_status || null;
    const attention = Boolean(
      latestAi?.status === "failed" ||
      ["dispatch_retry", "retry_scheduled", "failed"].includes(String(autoStatus || "").toLowerCase())
    );

    return {
      id: authUser.id,
      email: authUser.email || null,
      phone: authUser.phone || null,
      name: userDisplayName(authUser, profile),
      created_at: authUser.created_at || null,
      last_sign_in_at: authUser.last_sign_in_at || null,
      onboarding_completed: Boolean(profile.onboarding_completed),
      plan_code: planCode,
      plan_name: planName(planCode),
      membership_status: entitlement.status || "active",
      membership_ends_at: entitlement.ends_at || null,
      extra_updates_remaining: Number(wallet.extra_updates_remaining || 0),
      next_plan_update_at: profile.next_plan_update_at || null,
      last_auto_plan_update_at: profile.last_auto_plan_update_at || null,
      auto_plan_update_status: autoStatus,
      auto_plan_last_error: profile.auto_plan_last_error || null,
      latest_ai_status: latestAi?.status || null,
      latest_ai_request_id: latestAi?.id || null,
      latest_plan_id: latestPlan?.id || null,
      latest_plan_created_at: latestPlan?.created_at || null,
      attention
    };
  });

  if (search) {
    users = users.filter(user =>
      [user.name, user.email, user.phone].filter(Boolean).join(" ").toLowerCase().includes(search)
    );
  }
  if (hasPlanFilter) users = users.filter(user => user.plan_code === planFilter);
  if (attentionOnly) users = users.filter(user => user.attention);

  return {
    users,
    page,
    per_page: perPage,
    total: Number(authResult.data?.total || users.length)
  };
}

async function loadUserDetail(db, userId) {
  const authResult = await db.auth.admin.getUserById(userId);
  if (authResult.error) throw authResult.error;

  const [profile, entitlements, wallet, aiRequests, plans] = await Promise.all([
    safeRows(db.from("profiles").select("*").eq("id", userId).maybeSingle(), {}),
    safeRows(db.from("user_entitlements").select("*").eq("user_id", userId).order("created_at", { ascending: false }), []),
    safeRows(db.from("ai_update_wallets").select("*").eq("user_id", userId).maybeSingle(), {}),
    safeRows(db.from("ai_requests").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(20), []),
    safeRows(db.from("weekly_plans").select("id,title,status,week_start,week_end,created_at,ai_summary").eq("user_id", userId).order("created_at", { ascending: false }).limit(12), [])
  ]);

  const authUser = authResult.data?.user || {};
  return {
    user: {
      id: authUser.id,
      email: authUser.email || null,
      phone: authUser.phone || null,
      name: userDisplayName(authUser, profile),
      created_at: authUser.created_at || null,
      last_sign_in_at: authUser.last_sign_in_at || null
    },
    profile: profile || {},
    entitlements: entitlements || [],
    wallet: wallet || {},
    ai_requests: (aiRequests || []).map(mapAiRequest),
    plans: plans || []
  };
}

async function loadAiRequests(db, params) {
  const status = String(params.get("status") || "all").toLowerCase();
  const sourceFilter = String(params.get("source") || "all").toLowerCase();
  const search = String(params.get("search") || "").trim().toLowerCase();
  const limit = Math.max(20, Math.min(200, Number(params.get("limit") || 100)));

  let query = db.from("ai_requests").select("*").order("created_at", { ascending: false }).limit(limit);
  if (status !== "all") query = query.eq("status", status);

  const rows = await safeRows(query, []);
  const userIds = [...new Set(rows.map(row => row.user_id).filter(Boolean))];
  const [profiles, authUsersResult] = await Promise.all([
    userIds.length ? safeRows(db.from("profiles").select("id,full_name").in("id", userIds), []) : [],
    db.auth.admin.listUsers({ page: 1, perPage: 1000 })
  ]);

  const profileMap = new Map(profiles.map(row => [row.id, row]));
  const authMap = new Map((authUsersResult.data?.users || []).map(user => [user.id, user]));

  let requests = rows.map(row => {
    const mapped = mapAiRequest(row);
    const authUser = authMap.get(row.user_id) || {};
    const profile = profileMap.get(row.user_id) || {};
    return {
      ...mapped,
      user_name: userDisplayName(authUser, profile),
      user_email: authUser.email || null
    };
  });

  if (sourceFilter !== "all") requests = requests.filter(row => row.request_source === sourceFilter);
  if (search) {
    requests = requests.filter(row =>
      [row.user_name, row.user_email, row.id, row.request_type, row.error_message]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(search)
    );
  }

  const counts = {
    all: requests.length,
    pending: requests.filter(row => row.status === "pending").length,
    processing: requests.filter(row => row.status === "processing").length,
    completed: requests.filter(row => row.status === "completed").length,
    failed: requests.filter(row => row.status === "failed").length,
    automatic: requests.filter(row => row.request_source === "scheduled_auto").length
  };

  return { requests, counts };
}

async function loadSystem(db) {
  const [latestAuto, queued, failed, profiles] = await Promise.all([
    safeRows(db.from("ai_requests").select("*").order("created_at", { ascending: false }).limit(100), []),
    safeCount(db.from("ai_requests").select("id", { count: "exact", head: true }).in("status", ["pending", "processing"])),
    safeCount(db.from("ai_requests").select("id", { count: "exact", head: true }).eq("status", "failed").gte("created_at", new Date(Date.now() - 7 * 86400000).toISOString())),
    safeRows(db.from("profiles").select("id,next_plan_update_at,auto_plan_update_status,auto_plan_last_error,last_auto_plan_update_at"), [])
  ]);

  const autoRows = latestAuto.filter(row => requestSource(row) === "scheduled_auto");
  const latestAutomatic = autoRows[0] ? mapAiRequest(autoRows[0]) : null;
  const retrying = profiles.filter(profile =>
    ["dispatch_retry", "retry_scheduled", "failed"].includes(String(profile.auto_plan_update_status || "").toLowerCase())
  );
  const due = profiles.filter(profile => profile.next_plan_update_at && new Date(profile.next_plan_update_at) <= new Date());

  return {
    environment: {
      supabase_url: Boolean(SUPABASE_URL),
      service_role_key: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      openai_key: Boolean(process.env.OPENAI_API_KEY),
      scheduler_secret: Boolean(process.env.SHAPECUE_SCHEDULER_SECRET),
      openai_model: process.env.OPENAI_MODEL || "gpt-5.4-mini"
    },
    scheduler: {
      configured: Boolean(process.env.SHAPECUE_SCHEDULER_SECRET),
      latest_automatic_request: latestAutomatic,
      queued_or_processing: queued,
      failed_last_7_days: failed,
      retries_waiting: retrying.length,
      updates_due: due.length
    },
    retry_profiles: retrying.slice(0, 20),
    generated_at: new Date().toISOString()
  };
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { ok: false, error: "Use GET." });
  }

  try {
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) {
      return jsonResponse(500, { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY missing in Netlify." });
    }

    const db = createClient(SUPABASE_URL, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const access = await requireAdmin(db, event);

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(event.queryStringParameters || {})) {
      if (value !== null && value !== undefined) params.set(key, String(value));
    }

    const section = String(params.get("section") || "access").toLowerCase();

    let data = {};
    if (section === "overview") data = await loadOverview(db);
    else if (section === "users") {
      const userId = params.get("user_id");
      data = userId ? await loadUserDetail(db, userId) : await loadUsers(db, params);
    }
    else if (section === "ai") data = await loadAiRequests(db, params);
    else if (section === "system") data = await loadSystem(db);
    else data = { access: true };

    return jsonResponse(200, {
      ok: true,
      admin: access.admin,
      section,
      ...data
    });
  } catch (error) {
    console.error("admin-dashboard-data error:", error);
    return jsonResponse(error.statusCode || 500, {
      ok: false,
      error: error.message || "Could not load admin data."
    });
  }
}
