import {
  type BroadcastDeps,
  type BroadcastParams,
  sendBroadcast,
} from "./broadcast-notification.ts";
import type { TranslationResult } from "./translation-service.ts";

export interface LocalTimeJob extends BroadcastParams {
  id: string;
  translated_payloads: {
    preparing?: boolean;
    payloads?: Record<string, TranslationResult>;
  } | null;
}
export interface DeliveryState {
  window_closed: boolean;
  fallback_done: boolean;
  unclaimed: number;
  active_sends: number;
  partial_failures: number;
  counts: Partial<Record<"sending" | "sent" | "failed" | "skipped", number>>;
}
export function completionStatus(
  state: DeliveryState,
): "sent" | "failed" | null {
  if (
    !state.window_closed || !state.fallback_done || state.unclaimed > 0 ||
    state.active_sends > 0
  ) {
    return null;
  }
  return (state.counts.sent ?? 0) > 0 ? "sent" : "failed";
}

// PostgreSQL intervals from RPCs arrive as strings; compare in SQL instead of
// interpreting calendar units in JavaScript. This boolean is returned by the RPC.
export function bucketAction(tooLate: boolean): "skipped" | "sending" {
  return tooLate ? "skipped" : "sending";
}

/** Every insert is awaited before dispatch; a duplicate or crashed claim is final. */
export async function processLocalTimeJob(
  job: LocalTimeJob,
  correlationId: string,
  deps: BroadcastDeps,
  deadline: number,
  now: () => number = Date.now,
): Promise<void> {
  const db = deps.supabase;
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const result = await db.rpc(name, args);
    if (result.error) throw new Error(result.error.message);
    return result.data;
  };
  const due = await rpc("due_local_time_bucket_actions", {
    p_job_id: job.id,
  }) as {
    bucket: string;
    token_count: number;
    too_late: boolean;
  }[];
  let cache = job.translated_payloads;
  for (const bucket of due) {
    if (now() >= deadline) break;
    const action = bucketAction(bucket.too_late);
    if (action === "sending" && job.translate) {
      if (cache === null) {
        const owned = await rpc("claim_scheduled_translation", {
          p_job_id: job.id,
        });
        if (!owned) break; // Another invocation owns the whole-job preparation.
        // Persist an empty completed cache even if translation fails. Never retry
        // a partially successful translation batch on another timezone bucket.
        let payloads: Record<string, TranslationResult> = {};
        try {
          const translationLocales = await rpc("local_time_delivery_locales", {
            p_job_id: job.id,
          }) as string[];
          const prepared = await sendBroadcast(
            { ...job, prepareOnly: true, translationLocales },
            correlationId,
            deps,
          );
          payloads = prepared.translatedPayloads ?? {};
        } finally {
          cache = { payloads };
          const { error } = await db.from("scheduled_notifications")
            .update({ translated_payloads: cache }).eq("id", job.id)
            .eq("status", "delivering");
          if (error) throw new Error(error.message);
        }
      }
      if (cache.preparing) {
        // A preparation crash deliberately fails closed; let buckets age out.
        break;
      }
    }
    if (now() >= deadline) break;
    // INSERT ... ON CONFLICT DO NOTHING. Only returned rows own a send.
    const { data: claimed, error } = await db.from(
      "scheduled_notification_buckets",
    )
      .upsert({
        job_id: job.id,
        bucket: bucket.bucket,
        status: action,
        token_count: bucket.token_count,
        ...(action === "skipped"
          ? { finished_at: new Date(now()).toISOString() }
          : {}),
      }, { onConflict: "job_id,bucket", ignoreDuplicates: true }).select(
        "bucket",
      );
    if (error) throw new Error(error.message);
    if (!claimed?.length || action === "skipped") continue;
    let status = "failed";
    let result: unknown;
    try {
      const sent = await sendBroadcast(
        {
          ...job,
          precomputedTranslations: cache?.payloads,
          ...(bucket.bucket === "__no_timezone__"
            ? { nullTimezoneOnly: true }
            : { timezones: [bucket.bucket] }),
        },
        correlationId,
        deps,
      );
      status = sent.overallSuccess ? "sent" : "failed";
      result = sent;
    } catch (error) {
      result = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const { error: finishError } = await db.from(
      "scheduled_notification_buckets",
    )
      .update({ status, result, finished_at: new Date(now()).toISOString() })
      .eq("job_id", job.id).eq("bucket", bucket.bucket).eq("status", "sending");
    if (finishError) throw new Error(finishError.message);
  }
  const state = await rpc("local_time_delivery_state", {
    p_job_id: job.id,
  }) as DeliveryState;
  const status = completionStatus(state);
  if (status) {
    const incomplete = (state.counts.failed ?? 0) +
      (state.counts.sending ?? 0) + (state.counts.skipped ?? 0) +
      state.partial_failures;
    const { error } = await db.from("scheduled_notifications").update({
      status,
      failure_reason: incomplete || status === "failed"
        ? `Local-time buckets: ${
          JSON.stringify(state.counts)
        }; partial failures: ${state.partial_failures}`
        : null,
    }).eq("id", job.id).eq("status", "delivering");
    if (error) throw new Error(error.message);
  }
}
