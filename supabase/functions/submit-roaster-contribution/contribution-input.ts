// contribution-input
// ────────────────────────────────────────────────────────────────
// Pure input validation for submit-roaster-contribution (plan 030, step 2).
// Routes the submitted website/Instagram pair through the shared classifier
// (_shared/roaster-url.ts) so an Instagram account URL supplied in the
// website field is moved to the Instagram field, an Instagram-only
// contribution is valid, and conflicting accounts are rejected instead of
// guessed. index.ts calls Deno.serve at module scope, so this module exists
// so the validation stays unit-testable (see contribution-input_test.ts).
//
// Pure module: no I/O, no environment access, never throws.
// ────────────────────────────────────────────────────────────────
import {
  type RoasterUrlConflict,
  type RoasterUrlRouting,
  routeRoasterUrls,
} from "../_shared/roaster-url.ts";

export interface ParsedContributionInput {
  roaster: string;
  website_url: string | null;
  website_domain: string | null;
  instagram_url: string | null;
  city: string | null;
  country: string | null;
  routing: RoasterUrlRouting;
}

export type ContributionInputResult =
  | { ok: true; value: ParsedContributionInput }
  | { ok: false; status: number; error: string };

function extractDomain(urlStr: string): string | null {
  try {
    return new URL(urlStr).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

function cleanText(raw: unknown, maxLen = 120): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

const CONFLICT_MESSAGES: Record<RoasterUrlConflict, string> = {
  instagram_account_conflict:
    "website_url and instagram_url name two different Instagram accounts; submit only one so the official account is not guessed.",
  website_is_instagram_post:
    "website_url is an Instagram post/reel/story URL, not an account profile; submit the roaster's website or its Instagram profile instead.",
};

export function parseContributionInput(
  body: Record<string, unknown>,
): ContributionInputResult {
  const roaster = typeof body.roaster === "string" ? body.roaster.trim() : "";
  if (!roaster) {
    return { ok: false, status: 400, error: "Missing or invalid roaster" };
  }

  const routing = routeRoasterUrls(body.website_url, body.instagram_url);

  // A conflicting pair is never written: the caller must resolve which
  // account/field is correct, so nothing is stored and no job is queued.
  if (routing.conflict) {
    return {
      ok: false,
      status: 400,
      error: CONFLICT_MESSAGES[routing.conflict],
    };
  }

  const website_url = routing.website_url;
  const instagram_url = routing.instagram_url;
  if (!website_url && !instagram_url) {
    return {
      ok: false,
      status: 400,
      error:
        "A website or an Instagram profile is required: provide at least one usable identity URL.",
    };
  }

  // website_domain is derived from the routed website only, so an
  // Instagram-sourced value never produces a website domain.
  const website_domain = website_url ? extractDomain(website_url) : null;
  return {
    ok: true,
    value: {
      roaster,
      website_url,
      website_domain,
      instagram_url,
      city: cleanText(body.city),
      country: cleanText(body.country),
      routing,
    },
  };
}
