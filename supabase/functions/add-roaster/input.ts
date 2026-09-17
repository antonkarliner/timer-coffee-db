import { RoasterUrlRouting, routeRoasterUrls } from "../_shared/roaster-url.ts";

export interface AddRoasterRpcArguments {
  p_roaster_name: string;
  p_roaster_logo_url: string | null;
  p_roaster_website_url: string | null;
  p_aliases: string | null;
  p_city: string | null;
  p_state: string | null;
  p_country: string | null;
  p_address_text: string | null;
  p_instagram_url: string | null;
}

export type AddRoasterInputResult =
  | {
    ok: true;
    value: AddRoasterRpcArguments;
    routing: RoasterUrlRouting;
    clusterId: string | null;
  }
  | { ok: false; status: number; error: string };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeAliases(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  let parsedAliases: string[];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      parsedAliases = Array.isArray(parsed)
        ? parsed.map((alias) => String(alias))
        : [trimmed];
    } catch {
      parsedAliases = trimmed.split(",");
    }
  } else {
    parsedAliases = trimmed.split(",");
  }

  const normalizedAliases = parsedAliases
    .map((alias) => alias.trim())
    .filter(Boolean);
  return normalizedAliases.length > 0 ? normalizedAliases.join(",") : null;
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

export function parseAddRoasterInput(
  body: Record<string, unknown>,
): AddRoasterInputResult {
  const roasterName = body.roaster_name;
  if (typeof roasterName !== "string" || !roasterName.trim()) {
    return { ok: false, status: 400, error: "Missing or invalid roaster_name" };
  }

  const stringOrNullFields = [
    "roaster_logo_url",
    "roaster_website_url",
    "instagram_url",
    "aliases",
    "city",
    "state",
    "country",
  ] as const;
  for (const field of stringOrNullFields) {
    const value = body[field];
    if (value !== undefined && value !== null && typeof value !== "string") {
      return {
        ok: false,
        status: 400,
        error: `${field} must be a string or null`,
      };
    }
  }

  const normalizedAddress = body.address_text ?? body.address;
  if (
    normalizedAddress !== undefined && normalizedAddress !== null &&
    typeof normalizedAddress !== "string"
  ) {
    return {
      ok: false,
      status: 400,
      error: "address_text must be a string or null",
    };
  }

  const rawClusterId = body.cluster_id;
  if (
    rawClusterId !== undefined && rawClusterId !== null &&
    typeof rawClusterId !== "string"
  ) {
    return {
      ok: false,
      status: 400,
      error: "cluster_id must be a string or null",
    };
  }
  const clusterId = typeof rawClusterId === "string"
    ? trimToNull(rawClusterId)
    : null;
  if (clusterId !== null && !UUID_PATTERN.test(clusterId)) {
    return {
      ok: false,
      status: 400,
      error: "cluster_id must be a valid UUID",
    };
  }

  const routing = routeRoasterUrls(
    body.roaster_website_url,
    body.instagram_url,
  );
  if (routing.conflict === "instagram_account_conflict") {
    return {
      ok: false,
      status: 400,
      error:
        "roaster_website_url and instagram_url reference different Instagram accounts",
    };
  }
  if (routing.conflict === "website_is_instagram_post") {
    return {
      ok: false,
      status: 400,
      error:
        "roaster_website_url must not be an Instagram post, reel, story, or other non-profile URL",
    };
  }

  return {
    ok: true,
    value: {
      p_roaster_name: roasterName.trim(),
      p_roaster_logo_url: trimToNull(body.roaster_logo_url as string | null),
      p_roaster_website_url: trimToNull(routing.website_url),
      p_aliases: normalizeAliases(body.aliases as string | null),
      p_city: trimToNull(body.city as string | null),
      p_state: trimToNull(body.state as string | null),
      p_country: trimToNull(body.country as string | null),
      p_address_text: trimToNull(normalizedAddress as string | null),
      p_instagram_url: trimToNull(routing.instagram_url),
    },
    routing,
    clusterId,
  };
}
