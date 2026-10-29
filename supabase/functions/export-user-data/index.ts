// Self-serve user data export (Plan 035, Phase 2).
//
// Three actions on the JSON body `{ action, ... }`:
//
//   "request" { email }              -> emails a 6-digit OTP to `email` via
//                                        Resend, confirming control of that
//                                        inbox. Does NOT touch Supabase auth.
//   "confirm" { code, localData }    -> verifies the OTP, fetches the caller's
//                                        remote data (scoped to the verified
//                                        JWT user_id, never to `email` or any
//                                        client-supplied id), merges in the
//                                        client-assembled `localData`, zips
//                                        export.json + README.txt + CSVs,
//                                        uploads to the private `data-exports`
//                                        bucket, and emails a 1-hour signed
//                                        link. The signed URL is never
//                                        returned in the HTTP response.
//   "cleanup" (no body)              -> service-role/cron only. Removes
//                                        export zips older than 2 hours from
//                                        the `data-exports` bucket. Invoked by
//                                        `public.cleanup_data_exports_cron()`
//                                        (see the Phase 2 migration).
//
// "request" and "confirm" require the caller's own JWT (Authorization:
// Bearer <access_token>) and resolve `user_id` server-side from it, exactly
// like `roaster-admin-onboarding/index.ts`'s `verifyAdminUser`: an anon-key
// client carries the caller's token and calls `.auth.getUser()`. `user_id` is
// NEVER read from the request body.
//
// Storage bucket, `service.data_export_requests` table, and
// `service.cleanup_expired_data_exports()` (DB-row-only cleanup) were created
// in Phase 1 (20260726190000_data_export_requests.sql). This function does
// NOT delete those rows itself -- that stays on the hourly pg_cron job.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import JSZip from "https://esm.sh/jszip@3.10.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { isConnectedAppToken } from "../_shared/connected-app.ts";
import { createSecureResponse } from "../_shared/security-headers.ts";
import {
  checkIpRateLimit,
  createRateLimitResponse,
  getClientIP,
} from "../_shared/rate-limiter.ts";
import { buildCsv, pick } from "./csv.ts";

// ---------------------------------------------------------------------------
// Config / clients
// ---------------------------------------------------------------------------

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
// Optional: only used once the `edge_functions_api_key` Vault secret (see
// public.normalize_bean_origins_cron) is also mirrored as a Deno secret here.
// Until then, the cron wrapper falls back to `Authorization: Bearer
// <service_role_key>`, which `isAuthorizedServiceCaller` below already checks.
const edgeFunctionsApiKey = Deno.env.get("EDGE_FUNCTIONS_API_KEY") ?? "";

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}
if (!resendApiKey) {
  console.warn(
    "[export-user-data] RESEND_API_KEY is not configured; email delivery will fail.",
  );
}

const FROM_EMAIL = "Timer.Coffee <noreply@timer.coffee>";
const OTP_TTL_MINUTES = 10;
const MAX_LOCAL_DATA_BYTES = 5 * 1024 * 1024; // 5 MB, per plan 035
const MAX_REQUEST_BODY_BYTES = MAX_LOCAL_DATA_BYTES + 64 * 1024; // + slack for code/action fields
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour
const STALE_EXPORT_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
const EXPORT_BUCKET = "data-exports";
const REQUEST_RATE_LIMIT_PER_USER = 3; // per 24h, counted against data_export_requests
const REQUEST_RATE_LIMIT_PER_EMAIL = 3; // per 24h

// Service-role client for all data access (public schema tables + storage).
// `service.data_export_requests` lives in the `service` schema and is reached
// via `.schema('service')`, matching `clean-before-deletion/index.ts`'s use of
// `.schema('service').from('user_fcm_tokens')`.
const supabaseService = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  cors: Record<string, string>,
): Response {
  return createSecureResponse(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(email: unknown): email is string {
  return typeof email === "string" && email.length > 0 && email.length <= 254 &&
    EMAIL_RE.test(email);
}

function byteLength(str: string): number {
  return new TextEncoder().encode(str).length;
}

/** Cryptographically strong 6-digit numeric code, zero-padded. */
function generateOtp(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] % 1_000_000).toString().padStart(6, "0");
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Constant-time-ish comparison over byte arrays: always walks every byte,
 * never short-circuits on the first difference. Both inputs are SHA-256 hex
 * digests (always 64 hex chars / 32 bytes), so the length check is a static
 * sanity guard, not a data-dependent branch. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function sendResendEmail(
  to: string,
  subject: string,
  text: string,
  html: string,
): Promise<void> {
  if (!resendApiKey) {
    throw new Error("RESEND_API_KEY is not configured");
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${resendApiKey}`,
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, text, html }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[export-user-data] Resend send failed", res.status, body);
    throw new Error(`Failed to send email (status ${res.status})`);
  }
}

/** Resolves the caller's user_id from their own JWT. Mirrors
 * `roaster-admin-onboarding/index.ts`'s `verifyAdminUser`: an anon-key client
 * carries the caller's bearer token and asks Supabase auth who it belongs to.
 * `user_id` is NEVER taken from the request body. */
async function resolveUserId(
  req: Request,
): Promise<{ userId: string } | { errorResponse: { status: number; error: string } }> {
  const authHeader = req.headers.get("Authorization") ??
    req.headers.get("authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return { errorResponse: { status: 401, error: "Unauthorized - Bearer token required" } };
  }
  const accessToken = match[1];
  const supabaseUser = createClient(
    supabaseUrl,
    supabaseAnonKey || supabaseServiceRoleKey,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    },
  );
  const { data, error } = await supabaseUser.auth.getUser(accessToken);
  if (error || !data.user) {
    return { errorResponse: { status: 401, error: "Unauthorized - invalid or expired token" } };
  }
  if (isConnectedAppToken(accessToken)) {
    return { errorResponse: { status: 403, error: "Connected apps can't use this function" } };
  }
  return { userId: data.user.id };
}

/** Gate for the "cleanup" action: service-role/cron only. The migration's
 * `public.cleanup_data_exports_cron()` mirrors
 * `public.normalize_bean_origins_cron()` exactly, which sends either an
 * `apikey` header (once `edge_functions_api_key` is provisioned in Vault) or
 * falls back to `Authorization: Bearer <service_role_key>` -- the currently
 * functional path, since that Vault secret has not been provisioned yet (see
 * `20260708171500_migrate_pgnet_callers_to_apikey.sql`). Reject anything that
 * doesn't present one of those two credentials; a caller's own user JWT is
 * never sufficient here. */
function isAuthorizedServiceCaller(req: Request): boolean {
  const authHeader = req.headers.get("Authorization") ??
    req.headers.get("authorization") ?? "";
  const apikeyHeader = req.headers.get("apikey") ?? req.headers.get("Apikey") ?? "";
  if (authHeader === `Bearer ${supabaseServiceRoleKey}`) return true;
  if (apikeyHeader && apikeyHeader === supabaseServiceRoleKey) return true;
  if (edgeFunctionsApiKey && apikeyHeader === edgeFunctionsApiKey) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Remote data fetch + merge (action "confirm")
// ---------------------------------------------------------------------------

type RemoteRow = Record<string, unknown>;

interface RemoteBundle {
  userStats: RemoteRow[];
  coffeeBeans: RemoteRow[];
  recipePreferences: RemoteRow[];
  publicProfile: RemoteRow[];
  reviews: RemoteRow[];
  reviewReplies: RemoteRow[];
  recipes: RemoteRow[];
  steps: RemoteRow[];
  recipeLocalizations: RemoteRow[];
}

/** Ownership filters verified against prod 2026-07-26 (see plan 035 Phase 2
 * table). `user_recipes` has NO user_id column -- ownership is
 * `vendor_id = 'usr-' || user_id`, same convention
 * `clean-before-deletion/index.ts` uses to delete them. `user_steps` and
 * `user_recipe_localizations` only carry `recipe_id`, so they're fetched by
 * joining through the user's own recipe ids. `recipe_collections` is curated
 * catalog content, not user data, and is deliberately excluded, as are
 * `user_fcm_tokens`, `parse_coffee_label_invocations`, and `global_stats`. */
async function fetchRemoteBundle(userId: string): Promise<RemoteBundle> {
  const vendorId = `usr-${userId}`;

  const [
    userStatsRes,
    coffeeBeansRes,
    recipePreferencesRes,
    publicProfileRes,
    reviewsRes,
    reviewRepliesRes,
    recipesRes,
  ] = await Promise.all([
    supabaseService.from("user_stats").select("*").eq("user_id", userId),
    supabaseService.from("user_coffee_beans").select("*").eq("user_id", userId),
    supabaseService.from("user_recipe_preferences").select("*").eq("user_id", userId),
    supabaseService.from("user_public_profiles").select("*").eq("user_id", userId),
    supabaseService.from("bean_reviews").select("*").eq("user_id", userId),
    supabaseService.from("review_replies").select("*").eq("user_id", userId),
    supabaseService.from("user_recipes").select("*").eq("vendor_id", vendorId),
  ]);

  for (
    const [label, res] of [
      ["user_stats", userStatsRes],
      ["user_coffee_beans", coffeeBeansRes],
      ["user_recipe_preferences", recipePreferencesRes],
      ["user_public_profiles", publicProfileRes],
      ["bean_reviews", reviewsRes],
      ["review_replies", reviewRepliesRes],
      ["user_recipes", recipesRes],
    ] as const
  ) {
    if (res.error) {
      console.error(`[export-user-data] fetch ${label} failed`, res.error.message);
      throw new Error("Failed to assemble export data.");
    }
  }

  const recipeIds = (recipesRes.data ?? []).map((r) => r.id as string);

  let steps: RemoteRow[] = [];
  let recipeLocalizations: RemoteRow[] = [];
  if (recipeIds.length > 0) {
    const [stepsRes, localizationsRes] = await Promise.all([
      supabaseService.from("user_steps").select("*").in("recipe_id", recipeIds),
      supabaseService.from("user_recipe_localizations").select("*").in("recipe_id", recipeIds),
    ]);
    if (stepsRes.error) {
      console.error("[export-user-data] fetch user_steps failed", stepsRes.error.message);
      throw new Error("Failed to assemble export data.");
    }
    if (localizationsRes.error) {
      console.error(
        "[export-user-data] fetch user_recipe_localizations failed",
        localizationsRes.error.message,
      );
      throw new Error("Failed to assemble export data.");
    }
    steps = stepsRes.data ?? [];
    recipeLocalizations = localizationsRes.data ?? [];
  }

  return {
    userStats: userStatsRes.data ?? [],
    coffeeBeans: coffeeBeansRes.data ?? [],
    recipePreferences: recipePreferencesRes.data ?? [],
    publicProfile: publicProfileRes.data ?? [],
    reviews: reviewsRes.data ?? [],
    reviewReplies: reviewRepliesRes.data ?? [],
    recipes: recipesRes.data ?? [],
    steps,
    recipeLocalizations,
  };
}

/** Merges a remote bucket with the matching client-supplied local bucket.
 * Every record is tagged `_source`. On a true primary-key collision the
 * remote row wins (and the local duplicate is dropped); otherwise both are
 * kept. `local` is untrusted client input -- it is validated defensively and
 * NEVER used to decide whose remote data was read (that's always `userId`,
 * fixed before this function is called). */
function mergeBucket(
  remote: RemoteRow[],
  local: unknown,
  pkField: string,
): RemoteRow[] {
  const remoteTagged = remote.map((row) => ({ ...row, _source: "remote" as const }));
  const remoteKeys = new Set(
    remote
      .map((row) => row[pkField])
      .filter((v) => v !== undefined && v !== null)
      .map((v) => String(v)),
  );

  const localArray = Array.isArray(local) ? local : [];
  const localTagged: RemoteRow[] = [];
  for (const entry of localArray) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as RemoteRow;
    const pk = record[pkField];
    if (pk !== undefined && pk !== null && remoteKeys.has(String(pk))) {
      // True PK collision: remote wins, local duplicate dropped.
      continue;
    }
    localTagged.push({ ...record, _source: "local" as const });
  }

  return [...remoteTagged, ...localTagged];
}

// ---------------------------------------------------------------------------
// Zip contents
// ---------------------------------------------------------------------------

function buildReadme(generatedAtIso: string): string {
  return [
    "Timer.Coffee data export",
    `Generated: ${generatedAtIso} (UTC)`,
    "",
    "This download link expires 1 hour after this export was generated. If it",
    "has expired, request a new export from Settings > Export my data in the",
    "app.",
    "",
    "Files in this export:",
    "  export.json          Canonical, complete, nested export of everything",
    "                        below. Kept for portability and future re-import.",
    "                        Every record is tagged \"_source\": \"remote\" (synced",
    "                        to your account) or \"local\" (only ever stored on",
    "                        the device that requested this export).",
    "  brews.csv             Your logged brews.",
    "  beans.csv             Your coffee bean entries.",
    "  reviews.csv           Your bean reviews and any replies you posted.",
    "  custom_recipes.csv    Custom recipes you created, with their steps",
    "                        flattened in.",
    "",
    "Questions? Contact us through the app or at timer.coffee.",
    "",
  ].join("\n");
}

function buildBrewsCsv(rows: RemoteRow[]): string {
  const headers = [
    "id", "recipe_id", "brewing_method_id", "coffee_amount", "water_amount",
    "water_temp", "grind_size", "sweetness_slider_position",
    "strength_slider_position", "taste_balance", "tds_percent",
    "extraction_yield_percent", "rating", "tags", "notes", "beans", "roaster",
    "created_at", "is_marked", "source",
  ];
  const data = rows.map((r) => [
    pick(r, ["stat_uuid", "statUuid", "id"]),
    pick(r, ["recipe_id", "recipeId"]),
    pick(r, ["brewing_method_id", "brewingMethodId"]),
    pick(r, ["coffee_amount", "coffeeAmount"]),
    pick(r, ["water_amount", "waterAmount"]),
    pick(r, ["water_temp", "waterTemp"]),
    pick(r, ["grind_size", "grindSize"]),
    pick(r, ["sweetness_slider_position", "sweetnessSliderPosition"]),
    pick(r, ["strength_slider_position", "strengthSliderPosition"]),
    pick(r, ["taste_balance", "tasteBalance"]),
    pick(r, ["tds_percent", "tdsPercent"]),
    pick(r, ["extraction_yield_percent", "extractionYieldPercent"]),
    pick(r, ["rating"]),
    pick(r, ["tags"]),
    pick(r, ["notes"]),
    pick(r, ["beans"]),
    pick(r, ["roaster"]),
    pick(r, ["created_at", "createdAt"]),
    pick(r, ["is_marked", "isMarked"]),
    pick(r, ["_source"]),
  ]);
  return buildCsv(headers, data);
}

function buildBeansCsv(rows: RemoteRow[]): string {
  const headers = [
    "id", "roaster", "name", "origin", "variety", "processing_method",
    "region", "roast_level", "roast_date", "harvest_date", "elevation",
    "farm", "farmer", "package_weight_grams", "cupping_score", "grind_size",
    "is_favorite", "notes", "tasting_notes", "source",
  ];
  const data = rows.map((r) => [
    pick(r, ["beans_uuid", "beansUuid", "id"]),
    pick(r, ["roaster"]),
    pick(r, ["name"]),
    pick(r, ["origin"]),
    pick(r, ["variety"]),
    pick(r, ["processing_method", "processingMethod"]),
    pick(r, ["region"]),
    pick(r, ["roast_level", "roastLevel"]),
    pick(r, ["roast_date", "roastDate"]),
    pick(r, ["harvest_date", "harvestDate"]),
    pick(r, ["elevation"]),
    pick(r, ["farm"]),
    pick(r, ["farmer"]),
    pick(r, ["package_weight_grams", "packageWeightGrams"]),
    pick(r, ["cupping_score", "cuppingScore"]),
    pick(r, ["grind_size", "grindSize"]),
    pick(r, ["is_favorite", "isFavorite"]),
    pick(r, ["notes"]),
    pick(r, ["tasting_notes", "tastingNotes"]),
    pick(r, ["_source"]),
  ]);
  return buildCsv(headers, data);
}

function buildReviewsCsv(reviews: RemoteRow[], replies: RemoteRow[]): string {
  const headers = [
    "record_type", "id", "review_id", "bean_name", "roaster_name", "rating",
    "text", "sweetness", "acidity", "fruitiness", "body", "bitterness",
    "aftertaste", "would_buy_again", "flavor_tags", "is_public",
    "brewing_method_id", "created_at", "updated_at", "source",
  ];
  const reviewRows = reviews.map((r) => [
    "review",
    pick(r, ["id"]),
    pick(r, ["id"]),
    pick(r, ["bean_name", "beanName"]),
    pick(r, ["roaster_name", "roasterName"]),
    pick(r, ["rating"]),
    pick(r, ["review_text", "reviewText"]),
    pick(r, ["sweetness"]),
    pick(r, ["acidity"]),
    pick(r, ["fruitiness"]),
    pick(r, ["body"]),
    pick(r, ["bitterness"]),
    pick(r, ["aftertaste"]),
    pick(r, ["would_buy_again", "wouldBuyAgain"]),
    pick(r, ["flavor_tags", "flavorTags"]),
    pick(r, ["is_public", "isPublic"]),
    pick(r, ["brewing_method_id", "brewingMethodId"]),
    pick(r, ["created_at", "createdAt"]),
    pick(r, ["updated_at", "updatedAt"]),
    pick(r, ["_source"]),
  ]);
  const replyRows = replies.map((r) => [
    "reply",
    pick(r, ["id"]),
    pick(r, ["review_id", "reviewId"]),
    undefined,
    undefined,
    undefined,
    pick(r, ["reply_text", "replyText"]),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    pick(r, ["created_at", "createdAt"]),
    pick(r, ["updated_at", "updatedAt"]),
    pick(r, ["_source"]),
  ]);
  return buildCsv(headers, [...reviewRows, ...replyRows]);
}

function buildCustomRecipesCsv(
  recipes: RemoteRow[],
  steps: RemoteRow[],
  localizations: RemoteRow[],
): string {
  const stepsByRecipe = new Map<string, RemoteRow[]>();
  for (const step of steps) {
    const recipeId = String(pick(step, ["recipe_id", "recipeId"]) ?? "");
    if (!stepsByRecipe.has(recipeId)) stepsByRecipe.set(recipeId, []);
    stepsByRecipe.get(recipeId)!.push(step);
  }
  const localizationByRecipe = new Map<string, RemoteRow>();
  for (const loc of localizations) {
    const recipeId = String(pick(loc, ["recipe_id", "recipeId"]) ?? "");
    // Prefer an English localization if there are several; otherwise keep the
    // first one seen for this recipe.
    const existing = localizationByRecipe.get(recipeId);
    const locale = pick(loc, ["locale"]);
    if (!existing || locale === "en") {
      localizationByRecipe.set(recipeId, loc);
    }
  }

  const headers = [
    "id", "name", "short_description", "brewing_method_id", "coffee_amount",
    "water_amount", "water_temp", "brew_time", "is_public", "steps_count",
    "steps", "source",
  ];
  const data = recipes.map((r) => {
    const id = String(pick(r, ["id"]) ?? "");
    const recipeSteps = (stepsByRecipe.get(id) ?? [])
      .slice()
      .sort((a, b) => {
        const aOrder = Number(pick(a, ["step_order", "stepOrder"]) ?? 0);
        const bOrder = Number(pick(b, ["step_order", "stepOrder"]) ?? 0);
        return aOrder - bOrder;
      });
    const stepDescriptions = recipeSteps
      .map((s) => pick(s, ["description"]))
      .filter((d) => d !== undefined && d !== null)
      .join(" | ");
    const localization = localizationByRecipe.get(id);
    return [
      id,
      localization ? pick(localization, ["name"]) : undefined,
      localization ? pick(localization, ["short_description", "shortDescription"]) : undefined,
      pick(r, ["brewing_method_id", "brewingMethodId"]),
      pick(r, ["coffee_amount", "coffeeAmount"]),
      pick(r, ["water_amount", "waterAmount"]),
      pick(r, ["water_temp", "waterTemp"]),
      pick(r, ["brew_time", "brewTime"]),
      pick(r, ["ispublic", "isPublic"]),
      recipeSteps.length,
      stepDescriptions,
      pick(r, ["_source"]),
    ];
  });
  return buildCsv(headers, data);
}

// ---------------------------------------------------------------------------
// Action: "request"
// ---------------------------------------------------------------------------

async function handleRequestAction(
  parsed: Record<string, unknown>,
  userId: string,
  req: Request,
  cors: Record<string, string>,
): Promise<Response> {
  const email = parsed.email;
  if (!isValidEmail(email)) {
    return jsonResponse({ error: "A valid destination email is required." }, 400, cors);
  }

  // Coarse burst guard only. NOTE: the shared helpers are deliberately NOT used
  // for the per-user 24h cap. `checkUserRateLimit` neither filters nor writes
  // the `endpoint` column, so it is a GLOBAL per-user counter shared by every
  // function that calls it, over a 15-minute window
  // (ENVIRONMENT_CONFIG.rateLimitWindowMs defaults to 900000 ms). Using it here
  // would be both too strict (unrelated calls to other functions would block an
  // export) and far too lax for the actual goal: 3 per 15 min is up to 288 OTP
  // emails a day to arbitrary addresses. The real caps are the two endpoint-
  // specific 24h counts below, against service.data_export_requests.
  const clientIp = getClientIP(req);
  const ipRate = await checkIpRateLimit(clientIp);
  if (!ipRate.allowed) {
    return createRateLimitResponse(ipRate);
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Cap 1: how many exports this account may request per 24h. Endpoint-specific
  // by construction, since this table only ever records export requests.
  const { count: userRequestCount, error: userCountError } = await supabaseService
    .schema("service")
    .from("data_export_requests")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", since);
  if (userCountError) {
    console.error("[export-user-data] user rate check failed", userCountError.message);
    return jsonResponse({ error: "Internal server error" }, 500, cors);
  }
  if ((userRequestCount ?? 0) >= REQUEST_RATE_LIMIT_PER_USER) {
    return jsonResponse(
      {
        error: "Rate limit exceeded",
        message: "You've reached the daily limit for export requests. Try again tomorrow.",
      },
      429,
      cors,
    );
  }

  // Cap 2: requests targeting the same destination inbox, regardless of which
  // account (or how many different accounts) is asking.
  const { count: emailRequestCount, error: emailCountError } = await supabaseService
    .schema("service")
    .from("data_export_requests")
    .select("id", { count: "exact", head: true })
    .eq("dest_email", email)
    .gte("created_at", since);
  if (emailCountError) {
    console.error("[export-user-data] email rate check failed", emailCountError.message);
    return jsonResponse({ error: "Internal server error" }, 500, cors);
  }
  if ((emailRequestCount ?? 0) >= REQUEST_RATE_LIMIT_PER_EMAIL) {
    return jsonResponse(
      {
        error: "Rate limit exceeded",
        message: "Too many export requests for this email address. Try again later.",
      },
      429,
      cors,
    );
  }

  const code = generateOtp();
  const codeHash = await sha256Hex(code);
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString();

  // Supersede any prior unconsumed row for this user before inserting a new
  // one, so only the most recently sent code is ever valid.
  // Supersede by EXPIRING the prior rows, not deleting them. `confirm` only
  // accepts the newest unconsumed AND unexpired row, so back-dating expires_at
  // invalidates the old code just as effectively as a delete would.
  //
  // Deleting them would break rate limiting: the per-user 24h cap below counts
  // rows in this table, so a user who never confirms would erase their own
  // history on every request and could mint unlimited OTP emails.
  const { error: supersedeError } = await supabaseService
    .schema("service")
    .from("data_export_requests")
    .update({ expires_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString());
  if (supersedeError) {
    console.error("[export-user-data] failed to supersede prior request", supersedeError.message);
    // Non-fatal: the old row would simply also be valid until it expires or
    // its own attempt budget runs out. Proceed with issuing a new code.
  }

  const { error: insertError } = await supabaseService
    .schema("service")
    .from("data_export_requests")
    .insert({
      user_id: userId,
      dest_email: email,
      code_hash: codeHash,
      expires_at: expiresAt,
    });
  if (insertError) {
    console.error("[export-user-data] failed to store export request", insertError.message);
    return jsonResponse({ error: "Internal server error" }, 500, cors);
  }

  const text =
    `Your Timer.Coffee data export code is: ${code}\n\n` +
    `Enter this code in the app to confirm your export. It expires in ${OTP_TTL_MINUTES} minutes.\n\n` +
    `If you didn't request this, you can safely ignore this email.`;
  const html =
    `<p>Your Timer.Coffee data export code is:</p>` +
    `<p style="font-size:28px;font-weight:bold;letter-spacing:4px;">${code}</p>` +
    `<p>Enter this code in the app to confirm your export. It expires in ${OTP_TTL_MINUTES} minutes.</p>` +
    `<p>If you didn't request this, you can safely ignore this email.</p>`;

  try {
    await sendResendEmail(email, "Your Timer.Coffee data export code", text, html);
  } catch (err) {
    console.error(
      "[export-user-data] failed to send OTP email",
      err instanceof Error ? err.message : String(err),
    );
    return jsonResponse({ error: "Failed to send confirmation email. Please try again." }, 502, cors);
  }

  // Always 200 regardless of whether the destination "exists" -- it's a
  // delivery address, not an account lookup.
  return jsonResponse({ ok: true }, 200, cors);
}

// ---------------------------------------------------------------------------
// Action: "confirm"
// ---------------------------------------------------------------------------

async function handleConfirmAction(
  parsed: Record<string, unknown>,
  userId: string,
  cors: Record<string, string>,
): Promise<Response> {
  const code = parsed.code;
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
    return jsonResponse({ error: "A valid 6-digit code is required." }, 400, cors);
  }
  const localData = parsed.localData;

  const nowIso = new Date().toISOString();
  const { data: rows, error: fetchError } = await supabaseService
    .schema("service")
    .from("data_export_requests")
    .select("*")
    .eq("user_id", userId)
    .is("consumed_at", null)
    .gt("expires_at", nowIso)
    .order("created_at", { ascending: false })
    .limit(1);
  if (fetchError) {
    console.error("[export-user-data] failed to load export request", fetchError.message);
    return jsonResponse({ error: "Internal server error" }, 500, cors);
  }
  const row = rows?.[0];
  if (!row) {
    return jsonResponse(
      { error: "No active export request found. Please request a new code." },
      400,
      cors,
    );
  }

  // Increment attempts FIRST, before checking the code, so a lockout is
  // recorded even if the process fails partway through.
  const newAttempts = (row.attempts as number) + 1;
  const { error: attemptsError } = await supabaseService
    .schema("service")
    .from("data_export_requests")
    .update({ attempts: newAttempts })
    .eq("id", row.id);
  if (attemptsError) {
    console.error("[export-user-data] failed to record attempt", attemptsError.message);
    return jsonResponse({ error: "Internal server error" }, 500, cors);
  }

  const maxAttempts = row.max_attempts as number;
  if (newAttempts > maxAttempts) {
    return jsonResponse(
      { error: "Too many incorrect attempts. Please request a new code." },
      429,
      cors,
    );
  }

  const codeHash = await sha256Hex(code);
  const matches = constantTimeEqual(hexToBytes(codeHash), hexToBytes(row.code_hash as string));
  if (!matches) {
    return jsonResponse(
      {
        error: "Incorrect code.",
        attemptsRemaining: Math.max(0, maxAttempts - newAttempts),
      },
      400,
      cors,
    );
  }

  // Size-cap localData (untrusted client input). The raw request body was
  // already bounded in the top-level dispatcher, but re-check the field
  // itself in case other fields padded the body under that ceiling.
  if (localData !== undefined) {
    const serializedSize = byteLength(JSON.stringify(localData));
    if (serializedSize > MAX_LOCAL_DATA_BYTES) {
      return jsonResponse({ error: "Local data payload is too large." }, 413, cors);
    }
  }
  const localBundle = (localData && typeof localData === "object" && !Array.isArray(localData))
    ? localData as Record<string, unknown>
    : {};

  const { error: consumeError } = await supabaseService
    .schema("service")
    .from("data_export_requests")
    .update({ consumed_at: nowIso })
    .eq("id", row.id);
  if (consumeError) {
    console.error("[export-user-data] failed to mark request consumed", consumeError.message);
    return jsonResponse({ error: "Internal server error" }, 500, cors);
  }

  const destEmail = row.dest_email as string;

  let remote: RemoteBundle;
  try {
    remote = await fetchRemoteBundle(userId);
  } catch (err) {
    console.error(
      "[export-user-data] fetchRemoteBundle failed",
      err instanceof Error ? err.message : String(err),
    );
    return jsonResponse({ error: "Failed to assemble export data. Please try again." }, 500, cors);
  }

  const generatedAtIso = new Date().toISOString();
  const bundle = {
    meta: { generatedAt: generatedAtIso },
    brews: mergeBucket(remote.userStats, localBundle.brews, "stat_uuid"),
    beans: mergeBucket(remote.coffeeBeans, localBundle.beans, "beans_uuid"),
    recipePreferences: mergeBucket(
      remote.recipePreferences,
      localBundle.recipePreferences,
      "recipe_id",
    ),
    publicProfile: mergeBucket(remote.publicProfile, localBundle.publicProfile, "user_id"),
    reviews: mergeBucket(remote.reviews, localBundle.reviews, "id"),
    reviewReplies: mergeBucket(remote.reviewReplies, localBundle.reviewReplies, "id"),
    customRecipes: mergeBucket(remote.recipes, localBundle.customRecipes, "id"),
    recipeSteps: mergeBucket(remote.steps, localBundle.recipeSteps, "id"),
    recipeLocalizations: mergeBucket(
      remote.recipeLocalizations,
      localBundle.recipeLocalizations,
      "id",
    ),
  };

  const zip = new JSZip();
  zip.file("README.txt", buildReadme(generatedAtIso));
  zip.file("export.json", JSON.stringify(bundle, null, 2));
  zip.file("brews.csv", buildBrewsCsv(bundle.brews));
  zip.file("beans.csv", buildBeansCsv(bundle.beans));
  zip.file("reviews.csv", buildReviewsCsv(bundle.reviews, bundle.reviewReplies));
  zip.file(
    "custom_recipes.csv",
    buildCustomRecipesCsv(bundle.customRecipes, bundle.recipeSteps, bundle.recipeLocalizations),
  );

  let zipBytes: Uint8Array;
  try {
    zipBytes = await zip.generateAsync({ type: "uint8array" });
  } catch (err) {
    console.error(
      "[export-user-data] zip generation failed",
      err instanceof Error ? err.message : String(err),
    );
    return jsonResponse({ error: "Failed to build export archive." }, 500, cors);
  }

  // Purge any prior export objects for this user before uploading the new
  // one (repeat exporters shouldn't accumulate zips). Direct SQL DELETE on
  // storage.objects is blocked by storage.protect_delete, so this always
  // goes through the Storage API.
  const { data: existingFiles, error: listError } = await supabaseService.storage
    .from(EXPORT_BUCKET)
    .list(userId);
  if (listError) {
    console.warn(
      "[export-user-data] could not list prior export objects (continuing)",
      listError.message,
    );
  } else if (existingFiles && existingFiles.length > 0) {
    const priorPaths = existingFiles.map((f) => `${userId}/${f.name}`);
    const { error: removeError } = await supabaseService.storage
      .from(EXPORT_BUCKET)
      .remove(priorPaths);
    if (removeError) {
      console.warn(
        "[export-user-data] could not remove prior export objects (continuing)",
        removeError.message,
      );
    }
  }

  const objectPath = `${userId}/${crypto.randomUUID()}.zip`;
  const { error: uploadError } = await supabaseService.storage
    .from(EXPORT_BUCKET)
    .upload(objectPath, zipBytes, { contentType: "application/zip", upsert: false });
  if (uploadError) {
    console.error("[export-user-data] upload failed", uploadError.message);
    return jsonResponse({ error: "Failed to store export archive." }, 500, cors);
  }

  const { data: signed, error: signError } = await supabaseService.storage
    .from(EXPORT_BUCKET)
    .createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS);
  if (signError || !signed?.signedUrl) {
    console.error(
      "[export-user-data] failed to create signed URL",
      signError?.message ?? "no signedUrl in response",
    );
    return jsonResponse({ error: "Failed to prepare download link." }, 500, cors);
  }

  const text =
    `Your Timer.Coffee data export is ready.\n\n` +
    `Download it within the next hour:\n${signed.signedUrl}\n\n` +
    `After that, the link expires and you'll need to request a new export from Settings.`;
  const html =
    `<p>Your Timer.Coffee data export is ready.</p>` +
    `<p><a href="${signed.signedUrl}">Download your export</a></p>` +
    `<p>This link expires in 1 hour. After that, you'll need to request a new export from Settings.</p>`;

  try {
    await sendResendEmail(destEmail, "Your Timer.Coffee data export is ready", text, html);
  } catch (err) {
    console.error(
      "[export-user-data] failed to send download link email",
      err instanceof Error ? err.message : String(err),
    );
    return jsonResponse({ error: "Export was created but the email could not be sent." }, 502, cors);
  }

  // Never return the signed URL in the HTTP response -- delivery is via
  // email only, matching the destination-inbox-control guarantee.
  return jsonResponse({ ok: true }, 200, cors);
}

// ---------------------------------------------------------------------------
// Action: "cleanup"
// ---------------------------------------------------------------------------

async function cleanupStaleExports(): Promise<number> {
  let removed = 0;
  let offset = 0;
  const pageSize = 100;

  while (true) {
    const { data: entries, error } = await supabaseService.storage
      .from(EXPORT_BUCKET)
      .list("", { limit: pageSize, offset });
    if (error) {
      console.error("[export-user-data] cleanup: failed to list top-level entries", error.message);
      break;
    }
    if (!entries || entries.length === 0) break;

    for (const entry of entries) {
      // Each top-level entry is a `{user_id}` pseudo-folder; recurse one
      // level to reach the actual zip objects.
      const { data: files, error: filesError } = await supabaseService.storage
        .from(EXPORT_BUCKET)
        .list(entry.name, { limit: 1000 });
      if (filesError) {
        console.error(
          `[export-user-data] cleanup: failed to list ${entry.name}`,
          filesError.message,
        );
        continue;
      }
      const now = Date.now();
      const stalePaths = (files ?? [])
        .filter((f) => {
          const createdAt = f.created_at ?? f.updated_at;
          if (!createdAt) return false;
          return now - new Date(createdAt).getTime() > STALE_EXPORT_AGE_MS;
        })
        .map((f) => `${entry.name}/${f.name}`);

      if (stalePaths.length > 0) {
        const { error: removeError } = await supabaseService.storage
          .from(EXPORT_BUCKET)
          .remove(stalePaths);
        if (removeError) {
          console.error(
            `[export-user-data] cleanup: failed to remove stale objects for ${entry.name}`,
            removeError.message,
          );
        } else {
          removed += stalePaths.length;
        }
      }
    }

    if (entries.length < pageSize) break;
    offset += pageSize;
  }

  return removed;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req.headers.get("origin") ?? undefined);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, cors);
  }

  try {
    const rawBody = await req.text();
    if (byteLength(rawBody) > MAX_REQUEST_BODY_BYTES) {
      return jsonResponse({ error: "Request payload is too large." }, 413, cors);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400, cors);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return jsonResponse({ error: "Invalid JSON body" }, 400, cors);
    }

    const action = parsed.action;

    if (action === "cleanup") {
      if (!isAuthorizedServiceCaller(req)) {
        return jsonResponse({ error: "Unauthorized" }, 403, cors);
      }
      const removed = await cleanupStaleExports();
      return jsonResponse({ ok: true, removed }, 200, cors);
    }

    if (action !== "request" && action !== "confirm") {
      return jsonResponse({ error: `Unsupported action: ${String(action)}` }, 400, cors);
    }

    const auth = await resolveUserId(req);
    if ("errorResponse" in auth) {
      return jsonResponse({ error: auth.errorResponse.error }, auth.errorResponse.status, cors);
    }

    if (action === "request") {
      return await handleRequestAction(parsed, auth.userId, req, cors);
    }
    return await handleConfirmAction(parsed, auth.userId, cors);
  } catch (err) {
    console.error(
      "[export-user-data] unhandled error",
      err instanceof Error ? err.message : String(err),
    );
    return jsonResponse({ error: "Internal server error" }, 500, cors);
  }
});
