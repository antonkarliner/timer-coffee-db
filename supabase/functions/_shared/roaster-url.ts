// roaster-url
// ────────────────────────────────────────────────────────────────
// Shared classifier/normalizer for roaster website and Instagram URLs
// (plan 030, step 1). Every ingestion path — user contributions, LLM
// enrichment, the admin create path — routes URL-shaped input through
// `classifyRoasterUrl` / `routeRoasterUrls` so an Instagram account URL
// supplied in the website field is moved to the dedicated Instagram field
// and canonicalized in exactly one place, deterministically.
//
// Pure module: no I/O, no environment access, never throws.
// ────────────────────────────────────────────────────────────────

export type RoasterUrlKind =
  | "website" // an independent official website
  | "instagram" // an Instagram ACCOUNT PROFILE url
  | "instagram_non_profile" // an Instagram host, but a post/reel/story/etc
  | "social" // some other known social network host
  | "invalid"; // unparseable or unusable

export interface RoasterUrlClassification {
  kind: RoasterUrlKind;
  /**
   * "website" -> canonical absolute website URL (hash stripped).
   * "instagram" -> `https://www.instagram.com/<handle>/`
   * "social" -> canonical absolute URL (a caller may still store it as a website).
   * "instagram_non_profile" and "invalid" -> null.
   */
  normalized: string | null;
  /** lowercased hostname of the parsed input, or null when unparseable */
  host: string | null;
  /** the Instagram handle (original case preserved) when kind === "instagram", else null */
  handle: string | null;
  /** machine-readable reason code, set for "instagram_non_profile", "social" and "invalid"; null otherwise */
  reason: string | null;
}

export type RoasterUrlConflict =
  | "instagram_account_conflict" // website field and instagram field name DIFFERENT accounts
  | "website_is_instagram_post"; // the website field holds a non-profile instagram URL

export interface RoasterUrlRouting {
  website_url: string | null;
  instagram_url: string | null;
  /** true when an Instagram account URL supplied in the website field was moved to instagram_url */
  routed: boolean;
  /** non-null means the caller MUST NOT write silently: reject or send to human review */
  conflict: RoasterUrlConflict | null;
  /** short human-readable decisions, safe to store in enrichment notes */
  notes: string[];
}

// Mirrors BINARY_EXTENSIONS in submit-roaster-contribution/index.ts.
const BINARY_EXTENSIONS = [
  ".pdf",
  ".zip",
  ".rar",
  ".7z",
  ".tar",
  ".gz",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
];

const MAX_URL_LENGTH = 2048;
// Mirrors the bare-handle length cap of normalizeInstagram in
// submit-roaster-contribution/index.ts.
const MAX_INSTAGRAM_INPUT_LENGTH = 512;
const MAX_INSTAGRAM_HANDLE_LENGTH = 30;

// Registered hosts whose subdomains (but not lookalike domains) count as
// Instagram. Matched on parsed hostname labels, never on substrings.
const INSTAGRAM_REGISTERED_HOSTS = ["instagram.com", "instagr.am"];

// Other known social networks -> reason code suffix. Only Instagram is
// rerouted by this plan; the rest stay storable in the website field.
const SOCIAL_HOST_NETWORKS: ReadonlyArray<readonly [string, string]> = [
  ["facebook.com", "facebook"],
  ["fb.com", "facebook"],
  ["m.me", "messenger"],
  ["twitter.com", "twitter"],
  ["x.com", "x"],
  ["tiktok.com", "tiktok"],
  ["linkedin.com", "linkedin"],
  ["youtube.com", "youtube"],
  ["youtu.be", "youtube"],
  ["pinterest.com", "pinterest"],
  ["threads.net", "threads"],
  ["threads.com", "threads"],
  ["vk.com", "vk"],
  ["t.me", "telegram"],
  ["wa.me", "whatsapp"],
  ["whatsapp.com", "whatsapp"],
  ["snapchat.com", "snapchat"],
  ["weibo.com", "weibo"],
  ["xiaohongshu.com", "xiaohongshu"],
];

// First Instagram path segments that are never account handles
// (instagram.com/<segment>/...). Compared case-insensitively.
const RESERVED_INSTAGRAM_SEGMENTS = new Set([
  "p",
  "reel",
  "reels",
  "stories",
  "s",
  "tv",
  "explore",
  "share",
  "accounts",
  "direct",
  "about",
  "developer",
  "legal",
  "privacy",
  "terms",
  "api",
  "web",
  "sessions",
  "emails",
  "challenge",
  "oauth",
  "login",
  "signup",
  "password",
]);

const INSTAGRAM_HANDLE_PATTERN = new RegExp(
  `^[A-Za-z0-9._]{1,${MAX_INSTAGRAM_HANDLE_LENGTH}}$`,
);

// Scheme names allow dots per the URL grammar, so "example.com:8080/x"
// matches this pattern too; such dot-bearing labels are treated as
// host:port below, while real schemes (javascript:, mailto:, ftp:, ...)
// are dot-free and get rejected.
const EXPLICIT_SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/**
 * Case-insensitive, exact-label host match: true when `host` equals
 * `registeredHost` or is a subdomain of it. Label-based, so
 * "notinstagram.com" and "instagram.com.evil.example" never match.
 */
function hostMatchesRegisteredHost(
  host: string,
  registeredHost: string,
): boolean {
  const registered = registeredHost.toLowerCase().split(".");
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  const labels = normalized.split(".");
  if (labels.length < registered.length) return false;
  if (labels.some((label) => label.length === 0)) return false;
  return labels
    .slice(labels.length - registered.length)
    .every((label, index) => label === registered[index]);
}

/** Hostname test for Instagram (instagram.com / instagr.am and subdomains). */
export function isInstagramHost(host: string): boolean {
  return INSTAGRAM_REGISTERED_HOSTS.some((registered) =>
    hostMatchesRegisteredHost(host, registered)
  );
}

function socialNetworkForHost(host: string): string | null {
  for (const [registeredHost, network] of SOCIAL_HOST_NETWORKS) {
    if (hostMatchesRegisteredHost(host, registeredHost)) return network;
  }
  return null;
}

/**
 * Hostname test for any known social platform: Instagram plus the networks
 * in SOCIAL_HOST_NETWORKS (exact-label match, so lookalike domains are not
 * social).
 */
export function isSocialPlatformHost(host: string): boolean {
  return isInstagramHost(host) || socialNetworkForHost(host) !== null;
}

// 1–30 chars, only A-Za-z0-9._, not all dots, no leading/trailing dot.
function isValidInstagramHandle(segment: string): boolean {
  if (!INSTAGRAM_HANDLE_PATTERN.test(segment)) return false;
  if (segment.startsWith(".") || segment.endsWith(".")) return false;
  if (/^\.+$/.test(segment)) return false; // all dots (defensive; covered above)
  return true;
}

function makeInvalid(
  reason: string,
  host: string | null = null,
): RoasterUrlClassification {
  return { kind: "invalid", normalized: null, host, handle: null, reason };
}

function makeNonProfile(
  host: string,
  reason: string,
): RoasterUrlClassification {
  return {
    kind: "instagram_non_profile",
    normalized: null,
    host,
    handle: null,
    reason,
  };
}

/**
 * Deterministically classify a raw website-shaped input. Structural checks
 * mirror normalizeWebsiteUrl in submit-roaster-contribution/index.ts so
 * behaviour does not regress, plus an explicit scheme guard: dot-free
 * non-http schemes (javascript:, mailto:, ftp:, data:, ...) are rejected
 * up front instead of surviving the https:// prefix as a bogus hostname.
 */
export function classifyRoasterUrl(raw: unknown): RoasterUrlClassification {
  if (typeof raw !== "string") return makeInvalid("not_a_string");
  const s = raw.trim();
  if (!s) return makeInvalid("empty");
  if (s.length > MAX_URL_LENGTH) return makeInvalid("too_long");

  const schemeMatch = EXPLICIT_SCHEME_PATTERN.exec(s);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    // A dot-bearing "scheme" is really host:port (e.g. "example.com:8080/x");
    // keep flowing through the https:// prefix exactly like the legacy code.
    if (scheme !== "http" && scheme !== "https" && !scheme.includes(".")) {
      return makeInvalid("unsupported_scheme");
    }
  }

  let candidate = s;
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return makeInvalid("unparseable");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return makeInvalid("unsupported_scheme");
  }
  const host = u.hostname.toLowerCase();
  // The rejected-input SET mirrors normalizeWebsiteUrl in
  // submit-roaster-contribution/index.ts; only the check order differs so
  // each category reports its own reason code.
  if (!host) return makeInvalid("host_missing_dot"); // require a real domain
  if (host.includes(":")) return makeInvalid("ipv6_literal");
  if (host === "localhost") return makeInvalid("localhost");
  if (host.endsWith(".local")) return makeInvalid("local_tld");
  if (!host.includes(".")) return makeInvalid("host_missing_dot");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return makeInvalid("ipv4_literal"); // SSRF hygiene
  const path = u.pathname.toLowerCase();
  if (BINARY_EXTENSIONS.some((ext) => path.endsWith(ext))) {
    return makeInvalid("binary_path");
  }

  u.hash = "";
  const canonical = u.toString();

  if (isInstagramHost(host)) {
    const segments = u.pathname.split("/").filter((segment) =>
      segment.length > 0
    );
    if (segments.length === 0) {
      return makeNonProfile(host, "instagram_bare_host");
    }
    const first = segments[0];
    if (RESERVED_INSTAGRAM_SEGMENTS.has(first.toLowerCase())) {
      return makeNonProfile(host, "instagram_reserved_path");
    }
    if (segments.length > 1) {
      return makeNonProfile(host, "instagram_multi_segment_path");
    }
    if (!isValidInstagramHandle(first)) {
      return makeNonProfile(host, "instagram_invalid_handle");
    }
    // Canonical Instagram form: always https, always www, one trailing
    // slash, no query/fragment; the handle's display casing is preserved.
    return {
      kind: "instagram",
      normalized: `https://www.instagram.com/${first}/`,
      host,
      handle: first,
      reason: null,
    };
  }

  const network = socialNetworkForHost(host);
  if (network) {
    return {
      kind: "social",
      normalized: canonical,
      host,
      handle: null,
      reason: `social_${network}`,
    };
  }

  return {
    kind: "website",
    normalized: canonical,
    host,
    handle: null,
    reason: null,
  };
}

/**
 * Convenience: returns the canonical instagram URL, or null if `raw` is not
 * an account profile. Bare handles are NOT URLs; see routeRoasterUrls for
 * the input that accepts them.
 */
export function normalizeInstagramUrl(raw: unknown): string | null {
  const c = classifyRoasterUrl(raw);
  return c.kind === "instagram" ? c.normalized : null;
}

/**
 * Classification of the dedicated Instagram input. Mirrors the bare-handle
 * acceptance of normalizeInstagram in submit-roaster-contribution/index.ts:
 * a string with no scheme and no dot is a handle ("@name" / "name"), not a
 * URL. Unlike the legacy helper it does NOT silently strip foreign
 * characters from the handle — an invalid handle stays invalid.
 */
function classifyInstagramInput(raw: unknown): RoasterUrlClassification {
  const parsed = classifyRoasterUrl(raw);
  if (parsed.kind === "instagram") return parsed;
  if (typeof raw !== "string") return parsed;
  const s = raw.trim();
  if (!s || s.length > MAX_INSTAGRAM_INPUT_LENGTH) return parsed;
  if (/^https?:\/\//i.test(s) || s.includes(".")) return parsed;
  const handle = s.startsWith("@") ? s.slice(1) : s;
  if (!isValidInstagramHandle(handle)) {
    return makeInvalid("instagram_invalid_handle");
  }
  return {
    kind: "instagram",
    normalized: `https://www.instagram.com/${handle}/`,
    host: "www.instagram.com",
    handle,
    reason: null,
  };
}

/**
 * Deterministically route a (websiteInput, instagramInput) pair into the two
 * destination fields. Pure — no I/O, no throwing. The Instagram input may be
 * a bare handle; the website input may not.
 */
export function routeRoasterUrls(
  websiteInput: unknown,
  instagramInput: unknown,
): RoasterUrlRouting {
  const w = classifyRoasterUrl(websiteInput);
  const i = classifyInstagramInput(instagramInput);
  const websiteSupplied = typeof websiteInput === "string" &&
    websiteInput.trim() !== "";
  const instagramSupplied = typeof instagramInput === "string" &&
    instagramInput.trim() !== "";

  let website_url: string | null = null;
  let instagram_url: string | null = null;
  let routed = false;
  let conflict: RoasterUrlConflict | null = null;
  const notes: string[] = [];

  if (w.kind === "instagram_non_profile") {
    // Rule 1: never store a post/reel/story URL as a website.
    conflict = "website_is_instagram_post";
    notes.push(
      `Website field held a non-profile Instagram URL (reason: ${w.reason}); not stored as a website.`,
    );
    if (i.kind === "instagram") instagram_url = i.normalized;
  } else if (w.kind === "instagram") {
    if (i.kind === "instagram") {
      if (w.handle!.toLowerCase() === i.handle!.toLowerCase()) {
        // Rule 3a: same account (case-insensitive) — deduplicate.
        instagram_url = i.normalized;
        routed = true;
        notes.push(
          `Website and Instagram fields named the same Instagram account (@${i.handle}); deduplicated.`,
        );
      } else {
        // Rule 3b: different accounts — never pick one silently.
        conflict = "instagram_account_conflict";
        notes.push(
          `Website and Instagram fields named different Instagram accounts (@${w.handle} vs @${i.handle}); nothing stored, needs review.`,
        );
      }
    } else {
      // Rule 2: the website field held an Instagram account — move it.
      instagram_url = w.normalized;
      routed = true;
      notes.push(
        `Website field held an Instagram account URL (@${w.handle}); moved to the Instagram field.`,
      );
    }
  } else {
    // Rule 4: normal storage; social hosts may stay in the website field.
    if (w.kind === "website" || w.kind === "social") website_url = w.normalized;
    if (i.kind === "instagram") instagram_url = i.normalized;
    if (w.kind === "invalid" && websiteSupplied) {
      notes.push(
        `Website field was not a usable URL (reason: ${w.reason}); ignored.`,
      );
    }
  }

  // Rule 5: a non-account Instagram input never lands in instagram_url and
  // is not a hard conflict on its own — record a note instead.
  if (i.kind !== "instagram" && instagramSupplied) {
    const why = i.reason ?? "not_an_instagram_account";
    notes.push(
      `Instagram field did not hold an Instagram account URL (reason: ${why}); ignored.`,
    );
  }

  return { website_url, instagram_url, routed, conflict, notes };
}
