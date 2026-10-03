import type { AudienceFilter } from "./audience-filter.ts";
import type {
  translateNotificationBatch,
  TranslationResult,
} from "./translation-service.ts";

export interface BroadcastParams {
  timezones?: string[];
  nullTimezoneOnly?: boolean;
  precomputedTranslations?: Record<string, TranslationResult>;
  /** Compute the whole-job cache without dispatching any tokens. */
  prepareOnly?: boolean;
  translationLocales?: string[];
  returnTranslations?: boolean;
  title: string;
  body: string;
  data: Record<string, unknown>;
  priority: "low" | "normal" | "high";
  platform: "all" | "ios" | "android" | "web";
  locale: string;
  translate: boolean;
  category?: string;
  audienceFilter?: AudienceFilter | null;
  target_user_ids?: string[] | null;
}
interface TokenRow {
  id: string;
  token: string;
  device_type: string;
  locale: string | null;
}
export interface BroadcastDeps {
  // PostgREST builders are thenable; callers supply their existing service client.
  supabase: {
    // deno-lint-ignore no-explicit-any
    from: (table: string) => any;
    // deno-lint-ignore no-explicit-any
    rpc: (
      name: string,
      args: Record<string, unknown>,
    ) => PromiseLike<{ data: any; error: { message: string } | null }>;
  };
  captureLocaleErrors?: boolean;
  respectDeliveryResults?: boolean;
  fetch: typeof fetch;
  translateNotificationBatch: typeof translateNotificationBatch;
  sendFunctionUrl: string;
  serviceRoleKey: string;
  logWarning?: (
    message: string,
    context: Record<string, unknown>,
    correlationId: string,
  ) => void;
}
export interface BroadcastResult {
  translatedPayloads?: Record<string, TranslationResult>;
  results: {
    notificationId: string;
    locale?: string;
    tokensTargeted: number;
    success: boolean;
  }[];
  totalTargeted: number;
  overallSuccess: boolean;
  targetLocales: string[];
  noTokens: boolean;
  failures: { locale: string; error: string }[];
  httpError?: { status: number; error: string };
}
export function mapPlatformToTargetDeviceTypes(platform: string): string[] {
  const normalized = platform.toLowerCase().trim();
  if (normalized === "all") return ["android", "ios", "web"];
  if (["ios", "android", "web"].includes(normalized)) return [normalized];
  throw new Error(
    `Invalid platform value: "${platform}". Valid values are: all, ios, android, web`,
  );
}

/** Fan out once per locale. No retries: a successful locale must never be resent. */
export async function sendBroadcast(
  params: BroadcastParams,
  correlationId: string,
  deps: BroadcastDeps,
): Promise<BroadcastResult> {
  const targetDeviceTypes = mapPlatformToTargetDeviceTypes(params.platform);
  const result: BroadcastResult = {
    results: [],
    totalTargeted: 0,
    overallSuccess: false,
    targetLocales: [],
    noTokens: false,
    failures: [],
  };
  let tokens: TokenRow[] | null;
  if (
    params.audienceFilter != null || params.timezones !== undefined ||
    params.nullTimezoneOnly || params.prepareOnly
  ) {
    const { data, error } = await deps.supabase.rpc("get_broadcast_tokens", {
      p_target_device_types: targetDeviceTypes,
      p_target_user_ids: params.target_user_ids ?? null,
      p_audience_filter: params.audienceFilter ?? null,
      ...(params.timezones !== undefined
        ? { p_timezones: params.timezones }
        : {}),
      ...(params.nullTimezoneOnly ? { p_null_timezone_only: true } : {}),
    });
    if (error) throw error;
    tokens = data as TokenRow[] | null;
    if (!tokens?.length) return { ...result, noTokens: true };
    result.targetLocales = [
      ...new Set(
        tokens.map((t) => t.locale).filter(
          (locale): locale is string => locale !== null,
        ),
      ),
    ].filter((locale) => locale && locale !== params.locale);
    // The existing sender groups NULL locales into English.
    if (
      tokens.some((t) => !t.locale) && !result.targetLocales.includes("en") &&
      params.locale !== "en"
    ) {
      result.targetLocales.push("en");
    }
  } else {
    let query = deps.supabase.from("user_fcm_tokens")
      .select("id, user_id, token, device_type, locale").eq("is_active", true)
      .in("device_type", targetDeviceTypes);
    if (params.target_user_ids?.length) {
      query = query.in("user_id", params.target_user_ids);
    }
    const { data, error } = await query;
    if (error) throw error;
    tokens = data as TokenRow[] | null;
    if (!tokens?.length) return { ...result, noTokens: true };
    const { data: locales, error: localesError } = await deps.supabase.rpc(
      "get_broadcast_target_locales",
      {
        p_target_device_types: targetDeviceTypes,
        p_target_user_ids: params.target_user_ids ?? null,
      },
    );
    if (localesError) {
      deps.logWarning?.("Failed to get target locales from tokens", {
        error: localesError.message,
      }, correlationId);
    }
    result.targetLocales = (locales || []).map((row: { locale: string }) =>
      row.locale
    )
      .filter((locale: string) => locale && locale !== params.locale);
  }
  if (params.translationLocales) {
    result.targetLocales = [...params.translationLocales];
  }
  if (!result.targetLocales.includes(params.locale)) {
    result.targetLocales.unshift(params.locale);
  }
  const send = (
    rows: TokenRow[],
    title: string,
    body: string,
    data: Record<string, unknown>,
    locale: string,
  ) =>
    deps.fetch(deps.sendFunctionUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deps.serviceRoleKey}`,
      },
      body: JSON.stringify({
        userId: null,
        ...(params.category !== undefined ? { category: params.category } : {}),
        tokens: rows.map((t) => ({
          token: t.token,
          device_type: t.device_type,
          locale: t.locale,
          id: t.id,
        })),
        title,
        body,
        data,
        priority: params.priority,
        platform: params.platform,
        locale,
      }),
    });
  const readError = async (response: Response): Promise<string> => {
    const text = await response.text();
    try {
      const json = JSON.parse(text);
      return json.error || json.message || "FCM service error";
    } catch {
      return text;
    }
  };
  if (params.translate) {
    const groups = new Map<string, TokenRow[]>();
    for (const token of tokens) {
      const locale = token.locale || "en";
      groups.set(locale, [...(groups.get(locale) || []), token]);
    }
    const translations = params.precomputedTranslations !== undefined
      ? new Map(Object.entries(params.precomputedTranslations))
      : await deps.translateNotificationBatch(
        result.targetLocales,
        params.title,
        params.body,
        params.data,
        correlationId,
      );
    if (params.prepareOnly || params.returnTranslations) {
      result.translatedPayloads = Object.fromEntries(translations);
    }
    if (params.prepareOnly) return result;
    for (const locale of result.targetLocales) {
      const rows = groups.get(locale) || [];
      if (!rows.length) continue;
      const translation = translations.get(locale);
      if (!translation) {
        result.failures.push({ locale, error: "No translation available" });
        continue;
      }
      try {
        const response = await send(rows, translation.title, translation.body, {
          ...params.data,
          ...translation.data,
        }, locale);
        if (response.ok) {
          const json = await response.json().catch(() => null);
          const id = Array.isArray(json?.results)
            ? json.results.find((r: { locale: string }) => r.locale === locale)
              ?.notificationId
            : undefined;
          const success = !deps.respectDeliveryResults ||
            json?.success !== false;
          if (!success) {
            result.failures.push({
              locale,
              error: "FCM service reported no successful delivery",
            });
          }
          if (
            deps.respectDeliveryResults && success &&
            Array.isArray(json?.results)
          ) {
            const failed = json.results.reduce(
              (sum: number, row: { tokensFailed?: number }) =>
                sum + (row.tokensFailed ?? 0),
              0,
            );
            if (failed > 0) {
              result.failures.push({
                locale,
                error: `${failed} tokens failed`,
              });
            }
          }
          result.results.push({
            notificationId: id ?? json?.notificationId ?? json?.id ?? "unknown",
            locale,
            tokensTargeted: rows.length,
            success,
          });
          result.overallSuccess ||= success;
        } else {
          result.failures.push({ locale, error: await readError(response) });
          result.results.push({
            notificationId: "unknown",
            locale,
            tokensTargeted: rows.length,
            success: false,
          });
        }
      } catch (error) {
        if (!deps.captureLocaleErrors) throw error;
        // Keep earlier successes visible even if a later locale's transport fails.
        result.failures.push({
          locale,
          error: error instanceof Error ? error.message : String(error),
        });
        result.results.push({
          notificationId: "unknown",
          locale,
          tokensTargeted: rows.length,
          success: false,
        });
      }
    }
    // Token locales omitted by an RPC failure must be visible to the scheduler.
    for (const locale of groups.keys()) {
      if (!result.targetLocales.includes(locale)) {
        result.failures.push({
          locale,
          error: "Locale absent from target locales",
        });
      }
    }
  } else {
    if (params.prepareOnly) return result;
    const response = await send(
      tokens,
      params.title,
      params.body,
      params.data,
      params.locale,
    );
    if (!response.ok) {
      result.httpError = {
        status: response.status,
        error: await readError(response),
      };
      result.failures.push({
        locale: params.locale,
        error: result.httpError.error,
      });
      return result;
    }
    const json = await response.json().catch(() => null);
    const notificationId = Array.isArray(json?.results)
      ? json.results[0]?.notificationId
      : json?.notificationId ?? json?.id ?? "unknown";
    const success = !deps.respectDeliveryResults || json?.success !== false;
    if (!success) {
      result.failures.push({
        locale: params.locale,
        error: "FCM service reported no successful delivery",
      });
    }
    if (
      deps.respectDeliveryResults && success && Array.isArray(json?.results)
    ) {
      const failed = json.results.reduce(
        (sum: number, row: { tokensFailed?: number }) =>
          sum + (row.tokensFailed ?? 0),
        0,
      );
      if (failed > 0) {
        result.failures.push({
          locale: params.locale,
          error: `${failed} tokens failed`,
        });
      }
    }
    result.results.push({
      notificationId,
      tokensTargeted: tokens.length,
      success,
    });
    result.overallSuccess = success;
  }
  result.totalTargeted = result.results.reduce(
    (sum, r) => sum + r.tokensTargeted,
    0,
  );
  return result;
}
