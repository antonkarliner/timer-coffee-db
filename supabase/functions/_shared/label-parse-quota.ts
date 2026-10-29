import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { resolveCaller } from "./caller-auth.ts";

export type LabelParseRoute = "primary" | "gemini";
export type LabelParseOutcome = "released" | "succeeded" | "failed_billed";
export type CallerDeps = {
  getUser: SupabaseClient["auth"]["getUser"];
  legacyUserId?: unknown;
};
export type QuotaDeps = {
  isProUser: (userId: string) => Promise<boolean>;
  reserve: (
    args: {
      p_user_id: string;
      p_units: number;
      p_limit: number;
      p_route: LabelParseRoute;
    },
  ) => Promise<
    { admitted: boolean; reservation_id: number | null; used: number }
  >;
  finalize: (id: number, outcome: LabelParseOutcome) => Promise<boolean>;
  log: (error: unknown) => void;
};

export function validateLabelParseInput(body: unknown, route: LabelParseRoute) {
  const invalid = (error: string) => ({
    ok: false as const,
    status: 400 as const,
    error,
  });
  if (
    !body || typeof body !== "object" || Array.isArray(body) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(body))
  ) return invalid("Invalid request body");
  const value = body as Record<string, unknown>;
  const images = value.imagesBase64 ?? [];
  if (!Array.isArray(images)) return invalid("imagesBase64 must be an array");
  if (images.length > 2) return invalid("At most 2 images are supported");
  if (
    images.some((image) =>
      typeof image !== "string" || image.trim().length === 0
    )
  ) return invalid("Images must be non-empty strings");
  if (images.some((image) => image.length > 12_000_000)) {
    return invalid("Image exceeds size limit");
  }
  let ocrText: string | null = null;
  if (
    route === "primary" && value.ocrText !== undefined
  ) {
    if (typeof value.ocrText !== "string") {
      return invalid("ocrText must be a string");
    }
    if (value.ocrText.length > 20_000) {
      return invalid("OCR text exceeds size limit");
    }
    ocrText = value.ocrText;
  }
  if (!images.length && !ocrText?.trim()) {
    return invalid(
      route === "primary"
        ? "No images or OCR text provided"
        : "No images provided",
    );
  }
  return {
    ok: true as const,
    images: images as string[],
    ocrText,
    locale: typeof value.locale === "string" ? value.locale : undefined,
    legacyUserId: value.userId,
    units: Math.max(1, images.length),
  };
}

export function labelParseIdentityMismatch(
  userId: string,
  legacyUserId: unknown,
) {
  return typeof legacyUserId === "string" && legacyUserId.length > 0 &&
    legacyUserId !== userId;
}

export async function resolveLabelParseCaller(req: Request, deps: CallerDeps) {
  try {
    const caller = await resolveCaller(
      req,
      { auth: { getUser: deps.getUser } } as SupabaseClient,
    );
    if (caller.ok) {
      if (labelParseIdentityMismatch(caller.user.id, deps.legacyUserId)) {
        return {
          ok: false as const,
          status: 403 as const,
          error: "Forbidden",
          message: "userId does not match the authenticated user.",
        };
      }
      return caller;
    }
    if (caller.status === 403) {
      return {
        ok: false as const,
        status: 403 as const,
        error: "Forbidden",
        message: "Connected apps can't use this function.",
      };
    }
  } catch { /* Auth lookup failures deny access. */ }
  return {
    ok: false as const,
    status: 401 as const,
    error: "Unauthorized",
    message: "A signed-in or guest session is required.",
  };
}

export async function admitLabelParse(
  deps: QuotaDeps,
  input: { userId: string; units: number; route: LabelParseRoute },
) {
  const proUser = await deps.isProUser(input.userId);
  const limit = proUser ? 500 : input.route === "primary" ? 20 : 10;
  const row = await deps.reserve({
    p_user_id: input.userId,
    p_units: input.units,
    p_limit: limit,
    p_route: input.route,
  });
  if (
    typeof row?.admitted !== "boolean" || !Number.isSafeInteger(row.used) ||
    row.used < 0 ||
    (row.admitted &&
      (!Number.isSafeInteger(row.reservation_id) || row.reservation_id! <= 0))
  ) throw new Error("Invalid quota reservation response");
  return {
    admitted: row.admitted,
    reservationId: row.reservation_id,
    used: row.used,
    limit,
    proUser,
  };
}

export async function finalizeLabelParse(
  deps: QuotaDeps,
  id: number,
  outcome: LabelParseOutcome,
) {
  try {
    if (!await deps.finalize(id, outcome)) {
      deps.log(new Error("Reservation was not finalized"));
    }
  } catch (error) {
    try {
      deps.log(error);
    } catch { /* Finalization must never break the response. */ }
  }
}

export function makeLabelParseDeps(
  client: SupabaseClient,
): QuotaDeps & CallerDeps {
  return {
    getUser: (token) => client.auth.getUser(token),
    async isProUser(userId) {
      const { data, error } = await client.from("pro_users").select("user_id")
        .eq("user_id", userId);
      if (error) throw error;
      if (!data) throw new Error("Missing Pro lookup result");
      return data.length > 0;
    },
    async reserve(args) {
      const { data, error } = await client.schema("service").rpc(
        "reserve_label_parse_units",
        args,
      );
      if (error) throw error;
      return data?.[0];
    },
    async finalize(id, outcome) {
      const { data, error } = await client.schema("service").rpc(
        "finalize_label_parse_reservation",
        { p_reservation_id: id, p_outcome: outcome },
      );
      if (error) throw error;
      return data === true;
    },
    log: (error) =>
      console.error("Label parse quota finalization failed:", error),
  };
}
