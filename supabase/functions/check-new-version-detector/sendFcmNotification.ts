import { getStoreUrl, resolveUpdateNotificationLocale, UPDATE_NOTIFICATION_BODY_BY_LOCALE, UPDATE_NOTIFICATION_TITLE } from "./notificationContent.ts";
import { supabase } from "./utils.ts";
export const APP_RELEASE_NOTIFICATION_CHUNK_SIZE = 250;
export async function sendFcmNotification(platform, version, deliveryState = {}) {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseServiceRoleKey) {
      throw new Error("[check-new-version] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set.");
    }
    const sendFunctionUrl = `${supabaseUrl}/functions/v1/send-fcm-notification`;
    const { data, error } = await supabase.schema("service").from("user_fcm_tokens").select("id, token, locale, created_at").eq("is_active", true).eq("device_type", platform).order("created_at", {
      ascending: true
    }).order("id", {
      ascending: true
    });
    if (error) {
      throw new Error(`[check-new-version] Error fetching FCM tokens for ${platform}: ${error.message}`);
    }
    const rows = data ?? [];
    if (rows.length === 0) {
      console.log(`[check-new-version] No active FCM tokens for ${platform}.`);
      return {
        completed: true,
        noTokens: true,
        nextState: {
          chunkSize: APP_RELEASE_NOTIFICATION_CHUNK_SIZE,
          totalTokens: 0,
          completedAt: new Date().toISOString()
        },
        chunk: null,
        responseBody: null
      };
    }
    const deduped = [];
    const seenTokens = new Set();
    for (const row of rows){
      if (!row?.token) continue;
      if (seenTokens.has(row.token)) continue;
      seenTokens.add(row.token);
      deduped.push({
        id: row.id ?? null,
        token: row.token,
        locale: row.locale ?? null
      });
    }
    if (deduped.length === 0) {
      console.log(`[check-new-version] No usable FCM tokens remained for ${platform} after deduplication.`);
      return {
        completed: true,
        noTokens: true,
        nextState: {
          chunkSize: APP_RELEASE_NOTIFICATION_CHUNK_SIZE,
          totalTokens: 0,
          completedAt: new Date().toISOString()
        },
        chunk: null,
        responseBody: null
      };
    }
    const tokensByLocale = new Map();
    for (const tokenRow of deduped){
      const locale = resolveUpdateNotificationLocale(tokenRow.locale);
      const list = tokensByLocale.get(locale) ?? [];
      list.push({
        id: tokenRow.id,
        token: tokenRow.token
      });
      tokensByLocale.set(locale, list);
    }
    const url = getStoreUrl(platform);
    const fcmData = {
      type: "app_update",
      platform,
      version,
      url
    };
    const normalizedState = normalizeDeliveryState(tokensByLocale, deliveryState);
    if (normalizedState.localeIndex >= normalizedState.localeOrder.length) {
      console.log(`[check-new-version] ${platform} release ${version} delivery is already complete.`);
      return {
        completed: true,
        noTokens: false,
        nextState: {
          ...normalizedState,
          completedAt: new Date().toISOString()
        },
        chunk: null,
        responseBody: null
      };
    }
    const locale = normalizedState.localeOrder[normalizedState.localeIndex];
    const tokenRows = locale ? tokensByLocale.get(locale) ?? [] : [];
    const offset = normalizedState.chunkOffset;
    const chunk = tokenRows.slice(offset, offset + normalizedState.chunkSize);
    if (!locale || chunk.length === 0) {
      const nextState = advanceDeliveryState(normalizedState, tokensByLocale);
      return {
        completed: nextState.localeIndex >= nextState.localeOrder.length,
        noTokens: false,
        nextState: {
          ...nextState,
          completedAt: nextState.localeIndex >= nextState.localeOrder.length ? new Date().toISOString() : undefined
        },
        chunk: null,
        responseBody: null
      };
    }
    const body = UPDATE_NOTIFICATION_BODY_BY_LOCALE[locale] ?? UPDATE_NOTIFICATION_BODY_BY_LOCALE.en;
    const response = await fetch(sendFunctionUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${supabaseServiceRoleKey}`
      },
      body: JSON.stringify({
        userId: null,
        title: UPDATE_NOTIFICATION_TITLE,
        body,
        data: fcmData,
        deep_link: url,
        priority: "high",
        category: "app_update",
        locale,
        requestId: `release:${platform}:${version}:${locale}:${offset}`,
        target_device_types: [
          platform
        ],
        tokens: chunk.map((tokenRow)=>({
            token: tokenRow.token,
            device_type: platform,
            locale,
            id: tokenRow.id ?? undefined
          }))
      })
    });
    if (!response.ok) {
      const errorBody = await response.text().catch(()=>"");
      throw new Error(`[check-new-version] send-fcm-notification failed (${platform}, ${locale}, offset=${offset}): HTTP ${response.status} ${errorBody}`);
    }
    const responseBody = await response.json().catch(()=>null);
    const nextState = advanceDeliveryState(normalizedState, tokensByLocale);
    const completed = nextState.localeIndex >= nextState.localeOrder.length;
    console.log(`[check-new-version] Processed app release chunk for ${platform} ${version}: locale=${locale} offset=${offset} size=${chunk.length} completed=${completed}`);
    return {
      completed,
      noTokens: false,
      nextState: {
        ...nextState,
        lastLocale: locale,
        lastOffset: offset,
        lastTokenCount: chunk.length,
        completedAt: completed ? new Date().toISOString() : undefined
      },
      chunk: {
        locale,
        offset,
        tokenCount: chunk.length
      },
      responseBody
    };
  } catch (error) {
    console.error("[check-new-version] Unexpected error sending FCM notification:", error);
    throw error;
  }
}
function normalizeDeliveryState(tokensByLocale, deliveryState) {
  const currentLocaleOrder = Array.from(tokensByLocale.keys());
  const persistedLocaleOrder = Array.isArray(deliveryState.localeOrder) ? deliveryState.localeOrder.filter((locale)=>currentLocaleOrder.includes(locale)) : [];
  const localeOrder = [
    ...persistedLocaleOrder,
    ...currentLocaleOrder.filter((locale)=>!persistedLocaleOrder.includes(locale))
  ];
  const localeIndex = Number.isInteger(deliveryState.localeIndex) ? Math.max(0, deliveryState.localeIndex ?? 0) : 0;
  const chunkOffset = Number.isInteger(deliveryState.chunkOffset) ? Math.max(0, deliveryState.chunkOffset ?? 0) : 0;
  const chunkSize = Number.isInteger(deliveryState.chunkSize) && (deliveryState.chunkSize ?? 0) > 0 ? deliveryState.chunkSize : APP_RELEASE_NOTIFICATION_CHUNK_SIZE;
  const totalTokens = Array.from(tokensByLocale.values()).reduce((sum, rows)=>sum + rows.length, 0);
  const normalized = {
    localeOrder,
    localeIndex,
    chunkOffset,
    chunkSize,
    totalTokens
  };
  return advanceDeliveryState(normalized, tokensByLocale, true);
}
function advanceDeliveryState(deliveryState, tokensByLocale, normalizeCurrentCursor = false) {
  let localeIndex = deliveryState.localeIndex;
  let chunkOffset = deliveryState.chunkOffset;
  while(localeIndex < deliveryState.localeOrder.length){
    const locale = deliveryState.localeOrder[localeIndex];
    const tokenRows = locale ? tokensByLocale.get(locale) ?? [] : [];
    if (normalizeCurrentCursor) {
      if (chunkOffset < tokenRows.length) {
        break;
      }
    } else {
      chunkOffset += deliveryState.chunkSize;
      if (chunkOffset < tokenRows.length) {
        break;
      }
    }
    localeIndex += 1;
    chunkOffset = 0;
    if (normalizeCurrentCursor) {
      continue;
    }
  }
  return {
    localeOrder: deliveryState.localeOrder,
    localeIndex,
    chunkOffset,
    chunkSize: deliveryState.chunkSize,
    totalTokens: deliveryState.totalTokens
  };
}
