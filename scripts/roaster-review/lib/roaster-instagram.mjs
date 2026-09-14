import {
  classifyRoasterUrl,
  routeRoasterUrls,
} from "../../../supabase/functions/_shared/roaster-url.ts";

export { classifyRoasterUrl, routeRoasterUrls };

function supplied(value) {
  return typeof value === "string" && value.trim() !== "";
}

function addSource(entries, invalid, source, websiteValue, instagramValue) {
  const routed = routeRoasterUrls(websiteValue, instagramValue);
  const websiteOnly = routeRoasterUrls(websiteValue, null);
  const instagramOnly = routeRoasterUrls(null, instagramValue);
  const canonicalValues = new Set([
    websiteOnly.instagram_url,
    instagramOnly.instagram_url,
  ].filter(Boolean));
  for (const canonical of canonicalValues) {
    entries.push({
      source,
      value: canonical,
      account: new URL(canonical).pathname.split("/").filter(Boolean)[0],
    });
  }

  const website = classifyRoasterUrl(websiteValue);
  const instagram = supplied(instagramValue) ? instagramOnly : null;
  if (website.kind === "instagram_non_profile") {
    invalid.push(
      `${source} website: non-profile Instagram URL (${website.reason})`,
    );
  }
  if (supplied(instagramValue) && !instagram?.instagram_url) {
    const classified = classifyRoasterUrl(instagramValue);
    invalid.push(
      `${source} Instagram: not an Instagram account profile (${
        classified.reason ?? classified.kind
      })`,
    );
  }
  if (routed.conflict === "instagram_account_conflict") {
    invalid.push(
      `${source}: website and Instagram fields name different accounts`,
    );
  }
}

export function resolveCardInstagram(
  { proposed = {}, contributions = [], existingProfile = null } = {},
) {
  const entries = [];
  const invalid = [];

  addSource(
    entries,
    invalid,
    "LLM proposed",
    proposed.roaster_website_url,
    proposed.instagram_url,
  );
  for (const [index, contribution] of (contributions || []).entries()) {
    addSource(
      entries,
      invalid,
      `user-submitted contribution ${index + 1}`,
      contribution?.website_url,
      contribution?.instagram_url,
    );
  }
  if (existingProfile) {
    addSource(
      entries,
      invalid,
      "existing system profile",
      null,
      existingProfile.instagram_url,
    );
  }

  const accounts = new Map();
  for (const entry of entries) {
    const key = entry.account.toLowerCase();
    if (!accounts.has(key)) accounts.set(key, []);
    accounts.get(key).push(entry);
  }

  const sources = entries.map(({ source, value, account }) => ({
    source,
    value,
    account,
  }));
  if (invalid.length || accounts.size > 1) {
    const disagreements = [...accounts.values()]
      .flat()
      .map((entry) => `@${entry.account} from ${entry.source}`);
    const notes = [
      ...invalid,
      ...(accounts.size > 1
        ? [`Disagreeing Instagram accounts: ${disagreements.join("; ")}.`]
        : []),
    ];
    return {
      instagram_url: null,
      conflict: invalid.length
        ? "invalid_instagram_source"
        : "instagram_account_conflict",
      notes,
      sources,
    };
  }

  const agreed = entries[0] || null;
  return {
    instagram_url: agreed?.value ?? null,
    conflict: null,
    notes: agreed
      ? [
        `Instagram account @${agreed.account} agreed across ${
          entries.map((entry) => entry.source).join(", ")
        }.`,
      ]
      : [],
    sources,
  };
}

export function validatePayloadUrls(payload = {}) {
  const issues = [];
  const website = classifyRoasterUrl(payload.roaster_website_url);
  if (
    website.kind === "instagram" || website.kind === "instagram_non_profile"
  ) {
    issues.push("roaster_website_url must not contain an Instagram host");
  }

  const instagramValue = supplied(payload.instagram_url)
    ? payload.instagram_url.trim()
    : null;
  if (instagramValue) {
    const routed = routeRoasterUrls(null, instagramValue);
    if (!routed.instagram_url || routed.instagram_url !== instagramValue) {
      issues.push(
        "instagram_url must be a canonical Instagram account profile URL",
      );
    }
  }

  const websitePresent = supplied(payload.roaster_website_url);
  if (!websitePresent && !instagramValue) {
    issues.push("payload must include a website or Instagram URL");
  }
  return issues;
}

export function verifyRoasterInstagram(row = {}, expected) {
  const problems = [];
  const website = classifyRoasterUrl(row.roaster_website_url);
  if (
    website.kind === "instagram" || website.kind === "instagram_non_profile"
  ) {
    problems.push("stored roaster_website_url contains an Instagram host");
  }

  const expectedRoute = supplied(expected)
    ? routeRoasterUrls(null, expected)
    : null;
  const canonicalExpected = expectedRoute?.instagram_url ?? null;
  if (supplied(expected) && !canonicalExpected) {
    problems.push("expected Instagram value is not an account profile");
  } else if ((row.instagram_url ?? null) !== canonicalExpected) {
    problems.push(
      `stored instagram_url ${
        JSON.stringify(row.instagram_url ?? null)
      } does not match expected ${JSON.stringify(canonicalExpected)}`,
    );
  }

  return { ok: problems.length === 0, problems };
}
