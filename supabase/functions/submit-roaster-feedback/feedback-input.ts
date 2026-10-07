// feedback-input
// ────────────────────────────────────────────────────────────────
// Pure input validation for submit-roaster-feedback (plan 078, Phase 1).
// index.ts calls Deno.serve at module scope, so parsing/validation lives
// here to stay unit-testable (see feedback-input_test.ts).
//
// Field names from the client are camelCase (suggestedValue, contactEmail,
// fullName); the returned values use the snake_case column names of
// service.roaster_reports / service.roaster_claim_requests.
//
// Pure module: no I/O, no environment access, never throws. Length limits
// deliberately reject instead of truncating, matching the CHECK constraints
// on the tables.
// ────────────────────────────────────────────────────────────────

export const REPORT_CATEGORIES = [
  "wrong_location",
  "wrong_website",
  "wrong_social",
  "wrong_logo",
  "wrong_name",
  "wrong_business",
  "not_a_roaster",
  "closed",
  "duplicate",
  "other",
] as const;

export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const CLAIM_ROLES = ["owner", "employee", "agency", "other"] as const;

export type ClaimRole = (typeof CLAIM_ROLES)[number];

export const CLAIM_SOURCES = ["web", "app", "email"] as const;

export type ClaimSource = (typeof CLAIM_SOURCES)[number];

export interface ParsedReportInput {
  category: ReportCategory;
  suggested_value: string | null;
  details: string | null;
  contact_email: string | null;
}

export type ReportInputResult =
  | { ok: true; value: ParsedReportInput }
  | { ok: false; status: number; error: string };

export interface ParsedClaimInput {
  email: string;
  full_name: string;
  role: ClaimRole;
  message: string | null;
  source: ClaimSource;
}

export type ClaimInputResult =
  | { ok: true; value: ParsedClaimInput }
  | { ok: false; status: number; error: string };

export type ProfileRef = { roasterProfileId: string } | { slug: string };

// Simple structural email check: one @, non-empty local part, dotted domain.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LENGTH = 254;
const SUGGESTED_VALUE_MAX_LENGTH = 500;
const DETAILS_MAX_LENGTH = 1000;
const FULL_NAME_MAX_LENGTH = 120;
const MESSAGE_MAX_LENGTH = 1000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Roaster profile slugs, including numeric ones like "2376".
const SLUG_RE = /^[A-Za-z0-9-]{1,100}$/;

function trimmedString(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  return s ? s : null;
}

function isReportCategory(value: unknown): value is ReportCategory {
  return typeof value === "string" &&
    REPORT_CATEGORIES.includes(value as ReportCategory);
}

function isClaimRole(value: unknown): value is ClaimRole {
  return typeof value === "string" && CLAIM_ROLES.includes(value as ClaimRole);
}

function isClaimSource(value: unknown): value is ClaimSource {
  return typeof value === "string" &&
    CLAIM_SOURCES.includes(value as ClaimSource);
}

export function parseReportInput(
  body: Record<string, unknown>,
  opts: { allowContactEmail: boolean },
): ReportInputResult {
  const category = body.category;
  if (!isReportCategory(category)) {
    return { ok: false, status: 400, error: "Missing or invalid category" };
  }

  const suggestedValue = trimmedString(body.suggestedValue);
  if (
    suggestedValue !== null &&
    suggestedValue.length > SUGGESTED_VALUE_MAX_LENGTH
  ) {
    return {
      ok: false,
      status: 400,
      error: "suggestedValue must be at most 500 characters",
    };
  }

  const details = trimmedString(body.details);
  if (details !== null && details.length > DETAILS_MAX_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: "details must be at most 1000 characters",
    };
  }

  // A free-form report without any description cannot be triaged.
  if (category === "other" && details === null) {
    return {
      ok: false,
      status: 400,
      error: "details are required when category is other",
    };
  }

  // The web form offers an optional reply address; the app path does not,
  // so a contactEmail sent from the app is ignored, not rejected.
  let contactEmail: string | null = null;
  const rawContactEmail = trimmedString(body.contactEmail);
  if (opts.allowContactEmail && rawContactEmail !== null) {
    if (
      rawContactEmail.length > EMAIL_MAX_LENGTH ||
      !EMAIL_RE.test(rawContactEmail)
    ) {
      return { ok: false, status: 400, error: "Invalid contactEmail" };
    }
    contactEmail = rawContactEmail.toLowerCase();
  }

  return {
    ok: true,
    value: {
      category,
      suggested_value: suggestedValue,
      details,
      contact_email: contactEmail,
    },
  };
}

export function parseClaimInput(
  body: Record<string, unknown>,
): ClaimInputResult {
  // Must be the boolean true: the web form makes the caller tick a box, and
  // the string "true" (a common coercion bug) does not count.
  if (body.authorized !== true) {
    return {
      ok: false,
      status: 400,
      error: "authorization confirmation required",
    };
  }

  const rawEmail = trimmedString(body.email);
  if (rawEmail === null) {
    return { ok: false, status: 400, error: "Missing or invalid email" };
  }
  const email = rawEmail.toLowerCase();
  if (email.length > EMAIL_MAX_LENGTH || !EMAIL_RE.test(email)) {
    return { ok: false, status: 400, error: "Invalid email" };
  }

  const fullName = trimmedString(body.fullName);
  if (fullName === null) {
    return { ok: false, status: 400, error: "Missing or invalid fullName" };
  }
  if (fullName.length > FULL_NAME_MAX_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: "fullName must be at most 120 characters",
    };
  }

  const role = body.role;
  if (!isClaimRole(role)) {
    return { ok: false, status: 400, error: "Missing or invalid role" };
  }

  const message = trimmedString(body.message);
  if (message !== null && message.length > MESSAGE_MAX_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: "message must be at most 1000 characters",
    };
  }

  // An unrecognized source degrades to the default instead of failing the
  // request: the value is bookkeeping, not a precondition.
  const source: ClaimSource = isClaimSource(body.source) ? body.source : "web";

  return {
    ok: true,
    value: { email, full_name: fullName, role, message, source },
  };
}

export function parseProfileRef(
  body: Record<string, unknown>,
): ProfileRef | null {
  const rawId = body.roasterProfileId;
  if (typeof rawId === "string") {
    // The app addresses the profile by id; a present-but-malformed id is an
    // error, not a reason to fall through to the slug field.
    const id = rawId.trim();
    return UUID_RE.test(id) ? { roasterProfileId: id } : null;
  }
  const rawSlug = body.slug;
  if (typeof rawSlug === "string") {
    const slug = rawSlug.trim();
    if (SLUG_RE.test(slug)) return { slug };
  }
  return null;
}

// Personal-mail domains: a claim from one of these never "matches" a
// website domain, even when the roaster really is hosted there.
const FREE_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "web.de",
  "mail.ru",
  "yandex.ru",
  "yandex.com",
  "qq.com",
  "163.com",
  "naver.com",
  "zoho.com",
]);

// Store/platform hosts say nothing about the claimant's own domain.
const PLATFORM_HOSTS = [
  "myshopify.com",
  "shopify.com",
  "linktr.ee",
  "instagram.com",
  "facebook.com",
  "wixsite.com",
  "wix.com",
  "squarespace.com",
  "etsy.com",
  "square.site",
  "business.site",
  "google.com",
  "sites.google.com",
  "carrd.co",
  "bigcartel.com",
];

function websiteHost(websiteUrl: string | null): string | null {
  if (!websiteUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(websiteUrl);
  } catch {
    // Common input is a bare "roastery.com" with no scheme.
    try {
      parsed = new URL(`https://${websiteUrl}`);
    } catch {
      return null;
    }
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./i, "");
  return host || null;
}

function isDomainOrSubdomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Heuristic for claim triage only: does the claimant's email domain plausibly
 * belong to the roaster's website? Never used as proof — the operator decides.
 */
export function emailDomainMatchesWebsite(
  email: string,
  websiteUrl: string | null,
): boolean {
  const atIndex = email.lastIndexOf("@");
  const emailDomain = (
    atIndex === -1 ? email : email.slice(atIndex + 1)
  ).toLowerCase();
  if (!emailDomain) return false;

  if (FREE_MAIL_DOMAINS.has(emailDomain)) return false;

  const host = websiteHost(websiteUrl);
  if (!host) return false;

  if (PLATFORM_HOSTS.some((platform) => isDomainOrSubdomain(host, platform))) {
    return false;
  }

  return (
    host === emailDomain ||
    host.endsWith(`.${emailDomain}`) ||
    emailDomain.endsWith(`.${host}`)
  );
}
