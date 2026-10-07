// submit-roaster-feedback
// ────────────────────────────────────────────────────────────────
// Captures roaster-page error reports and roaster-page claim requests
// (plan 078, Phase 1). A report ("wrong location", "closed", ...) lands in
// service.roaster_reports for the operator queue, silently. A claim request
// lands in service.roaster_claim_requests, alerts the operator by email and
// Telegram, and gets a plain-text-style confirmation email to the claimant.
//
// Two caller paths:
//   - Web: a Cloudflare Turnstile token in the body proves a browser
//     session; rate-limited per IP; accepts reports and claims.
//   - App: any signed-in user via the Bearer token, anonymous sessions
//     included (a bare anon key resolves to no user → 401); rate-limited
//     per user; accepts reports only — claims are submitted on the website.
//
// Inserts run with the service-role key, so the tables have no insert
// policies for anon/authenticated (migration 20261004120000). Operator
// notifications are modelled on check-new-roaster: email via Resend from
// roasters@timer.coffee, gated by ROASTER_EMAIL_ENABLED/ADMIN_EMAIL, and
// Telegram gated by TELEGRAM_ENABLED/bot token/chat ids. Notification
// failures are logged and never fail the request.
// ────────────────────────────────────────────────────────────────
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
import {
  checkIpRateLimit,
  checkUserRateLimit,
  createRateLimitResponse,
  getClientIP,
} from "../_shared/rate-limiter.ts";
import {
  emailDomainMatchesWebsite,
  parseClaimInput,
  type ParsedClaimInput,
  parseProfileRef,
  parseReportInput,
} from "./feedback-input.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false, detectSessionInUrl: false },
});

// Web-submission anti-bot gate. Missing key degrades to a clear 503 so the
// website can fall back to the email contact instead of erroring oddly.
const turnstileSecret = Deno.env.get("TURNSTILE_SECRET_KEY");

// Operator-notification configuration, gated like check-new-roaster.
const resendApiKey = Deno.env.get("RESEND_API_KEY");
const adminEmail = Deno.env.get("ADMIN_EMAIL");
const emailEnabled = Deno.env.get("ROASTER_EMAIL_ENABLED") !== "false";
const telegramBotToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
const telegramChatIds = Deno.env.get("TELEGRAM_CHAT_IDS");
const telegramEnabled = Deno.env.get("TELEGRAM_ENABLED") !== "false";

const TURNSTILE_SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const RESEND_API_URL = "https://api.resend.com/emails";

// Max submissions per caller per rate-limit window.
const FEEDBACK_RATE_LIMIT = 10;

const ROASTER_PAGE_URL_PREFIX = "https://www.timer.coffee/roasters/";
const CLAIM_QUEUE_URL = "https://www.timer.coffee/admin/roaster-requests/";

interface RoasterProfile {
  id: string;
  slug: string;
  roaster_name: string | null;
  website_url: string | null;
  city: string | null;
  country: string | null;
  admin_user_id: string | null;
  is_active: boolean;
}

function json(
  body: Record<string, unknown>,
  status: number,
  cors: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

type TurnstileCheck =
  | { ok: true }
  | { ok: false; status: number; error: string };

async function verifyTurnstileToken(
  req: Request,
  token: string,
): Promise<TurnstileCheck> {
  if (!turnstileSecret) {
    return {
      ok: false,
      status: 503,
      error: "Web submissions are not configured",
    };
  }
  const form = new URLSearchParams({
    secret: turnstileSecret,
    response: token,
  });
  const ip = getClientIP(req);
  if (ip && ip !== "unknown") form.set("remoteip", ip);
  let response: Response;
  try {
    response = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  } catch (error) {
    console.error("turnstile siteverify unreachable:", error);
    return {
      ok: false,
      status: 502,
      error: "Challenge verification failed",
    };
  }
  let success = false;
  try {
    const data = await response.json();
    success = data?.success === true;
  } catch {
    success = false;
  }
  if (!success) {
    return { ok: false, status: 403, error: "Challenge verification failed" };
  }
  return { ok: true };
}

async function sendOperatorEmail(
  claim: ParsedClaimInput,
  profile: RoasterProfile,
  domainMatch: boolean,
): Promise<void> {
  if (!emailEnabled || !resendApiKey || !adminEmail) return;
  const roasterName = profile.roaster_name ?? profile.slug;
  const html =
    `<p>A new roaster page claim request is waiting in the queue.</p><p><strong>Roaster:</strong> ${
      escapeHtml(roasterName)
    }<br><strong>Public page:</strong> ${
      escapeHtml(`${ROASTER_PAGE_URL_PREFIX}${profile.slug}/`)
    }<br><strong>Website:</strong> ${
      escapeHtml(profile.website_url || "N/A")
    }</p><p><strong>Claimant:</strong> ${
      escapeHtml(claim.full_name)
    }<br><strong>Role:</strong> ${
      escapeHtml(claim.role)
    }<br><strong>Email:</strong> ${
      escapeHtml(claim.email)
    }<br><strong>Email domain matches website:</strong> ${
      domainMatch ? "yes" : "no"
    }<br><strong>Source:</strong> ${escapeHtml(claim.source)}</p>${
      claim.message
        ? `<p><strong>Message:</strong><br>${escapeHtml(claim.message)}</p>`
        : ""
    }<p>Review the queue: ${CLAIM_QUEUE_URL}</p>`;
  const response = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resendApiKey}`,
    },
    body: JSON.stringify({
      from: "roasters@timer.coffee",
      to: adminEmail,
      subject: `Roaster page claim request: ${roasterName}`,
      html,
    }),
  });
  if (!response.ok) {
    throw new Error(`Claim operator email failed: ${response.status}`);
  }
}

async function sendOperatorTelegram(
  claim: ParsedClaimInput,
  profile: RoasterProfile,
  domainMatch: boolean,
): Promise<void> {
  if (!telegramEnabled || !telegramBotToken || !telegramChatIds) return;
  const roasterName = profile.roaster_name ?? profile.slug;
  const message = [
    "New roaster page claim request",
    `Roaster: ${roasterName}`,
    `Public page: ${ROASTER_PAGE_URL_PREFIX}${profile.slug}/`,
    `Website: ${profile.website_url || "N/A"}`,
    `Claimant: ${claim.full_name} (${claim.role})`,
    `Email: ${claim.email}`,
    `Email domain matches website: ${domainMatch ? "yes" : "no"}`,
    `Source: ${claim.source}`,
    claim.message ? `Message: ${claim.message}` : null,
    `Queue: ${CLAIM_QUEUE_URL}`,
  ].filter((line): line is string => line !== null).join("\n");
  for (
    const chatId of telegramChatIds.split(",").map((value) => value.trim())
      .filter(Boolean)
  ) {
    const response = await fetch(
      `https://api.telegram.org/bot${telegramBotToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          disable_web_page_preview: true,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Claim Telegram alert failed: ${response.status}`);
    }
  }
}

async function sendClaimantConfirmation(
  claim: ParsedClaimInput,
  profile: RoasterProfile,
): Promise<void> {
  if (!resendApiKey) return;
  const roasterName = profile.roaster_name ?? "your roaster";
  const response = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resendApiKey}`,
    },
    body: JSON.stringify({
      from: "Timer.Coffee <roasters@timer.coffee>",
      reply_to: "support@timer.coffee",
      to: claim.email,
      subject: `We received your request for ${roasterName}`,
      html: `<p>Thanks for your claim request for ${
        escapeHtml(roasterName)
      }.</p><p>We review every request by hand and usually reply within a few business days.</p><p>Once your request is approved, you will get a separate email with steps to sign in and manage the page: the roaster details, logo, links, and replies to reviews.</p><p>If you didn't make this request, you can ignore this email — nothing else will happen to your address.</p>`,
    }),
  });
  if (!response.ok) {
    throw new Error(`Claim confirmation email failed: ${response.status}`);
  }
}

// A notification failure is logged and never fails the request: the row is
// already stored, and the operator queue is the source of truth.
async function sendClaimNotifications(
  claim: ParsedClaimInput,
  profile: RoasterProfile,
  domainMatch: boolean,
): Promise<void> {
  const results = await Promise.allSettled([
    sendOperatorEmail(claim, profile, domainMatch),
    sendOperatorTelegram(claim, profile, domainMatch),
    sendClaimantConfirmation(claim, profile),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("claim notification failed:", result.reason);
    }
  }
}

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req.headers.get("origin") ?? undefined);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, cors);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400, cors);
  }

  const kind = body.kind;
  if (kind !== "report" && kind !== "claim") {
    return json({ error: "kind must be report or claim" }, 400, cors);
  }

  // 1) Resolve the caller path. A Turnstile token marks a web submission;
  //    anything else is the app path with a Bearer-token user (anonymous
  //    users have a real uid via signInAnonymously; the bare anon key
  //    resolves to no user → 401).
  let source: "web" | "app";
  let userId: string | null = null;
  const turnstileToken = typeof body.turnstileToken === "string"
    ? body.turnstileToken.trim()
    : "";
  if (turnstileToken) {
    const check = await verifyTurnstileToken(req, turnstileToken);
    if (!check.ok) {
      return json({ error: check.error }, check.status, cors);
    }
    const rate = await checkIpRateLimit(getClientIP(req), FEEDBACK_RATE_LIMIT);
    if (!rate.allowed) {
      return createRateLimitResponse(rate);
    }
    source = "web";
  } else {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (token) {
      const { data: userData } = await supabase.auth.getUser(token);
      userId = userData?.user?.id ?? null;
    }
    if (!userId) {
      return json({ error: "Authentication required" }, 401, cors);
    }
    const rate = await checkUserRateLimit(userId, FEEDBACK_RATE_LIMIT);
    if (!rate.allowed) {
      return createRateLimitResponse(rate);
    }
    if (kind === "claim") {
      return json({ error: "claims are submitted on the website" }, 400, cors);
    }
    source = "app";
  }

  // 2) Resolve the target roaster page.
  const ref = parseProfileRef(body);
  if (!ref) {
    return json({ error: "Missing or invalid roaster reference" }, 400, cors);
  }
  const refColumn = "roasterProfileId" in ref ? "id" : "slug";
  const refValue = "roasterProfileId" in ref ? ref.roasterProfileId : ref.slug;
  const { data: profile, error: profileErr } = await supabase
    .schema("public")
    .from("roaster_profiles")
    .select(
      "id, slug, roaster_name, website_url, city, country, admin_user_id, is_active",
    )
    .eq(refColumn, refValue)
    .maybeSingle();
  if (profileErr) {
    console.error("roaster_profiles lookup failed:", profileErr);
    return json({ error: "Failed to load roaster" }, 500, cors);
  }
  if (!profile || !profile.is_active) {
    return json({ error: "Roaster not found" }, 404, cors);
  }

  if (kind === "report") {
    // 3) Store the report. No notifications: the operator queue is polled.
    const parsed = parseReportInput(body, {
      allowContactEmail: source === "web",
    });
    if (!parsed.ok) {
      return json({ error: parsed.error }, parsed.status, cors);
    }
    const { error: insertErr } = await supabase
      .schema("service")
      .from("roaster_reports")
      .insert({
        roaster_profile_id: profile.id,
        category: parsed.value.category,
        suggested_value: parsed.value.suggested_value,
        details: parsed.value.details,
        contact_email: parsed.value.contact_email,
        source,
        user_id: userId,
      });
    if (insertErr) {
      console.error("roaster_reports insert failed:", insertErr);
      return json({ error: "Failed to submit report" }, 500, cors);
    }
    return json({ status: "ok" }, 201, cors);
  }

  // 4) Claim request (web path only).
  if (profile.admin_user_id) {
    return json({ status: "already_claimed" }, 409, cors);
  }
  const parsedClaim = parseClaimInput(body);
  if (!parsedClaim.ok) {
    return json({ error: parsedClaim.error }, parsedClaim.status, cors);
  }
  const claim = parsedClaim.value;
  const domainMatch = emailDomainMatchesWebsite(
    claim.email,
    profile.website_url,
  );
  const { error: claimErr } = await supabase
    .schema("service")
    .from("roaster_claim_requests")
    .insert({
      roaster_profile_id: profile.id,
      email: claim.email,
      full_name: claim.full_name,
      role: claim.role,
      message: claim.message,
      email_domain_matches: domainMatch,
      source: claim.source,
    });
  if (claimErr) {
    if (claimErr.code === "23505") {
      // A pending claim for this roaster + email already exists. Answer
      // calmly and send nothing, so the address cannot be spammed by retry.
      return json({ status: "duplicate" }, 200, cors);
    }
    console.error("roaster_claim_requests insert failed:", claimErr);
    return json({ error: "Failed to submit claim request" }, 500, cors);
  }

  await sendClaimNotifications(claim, profile, domainMatch);
  return json({ status: "ok" }, 201, cors);
});
