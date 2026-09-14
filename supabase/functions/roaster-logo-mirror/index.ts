/**
 * Legacy database-webhook entry point for roaster logo mirroring.
 *
 * The processing pipeline now lives in `_shared/roaster-logo-mirror-core.ts`
 * so that this function and the durable `roaster-postprocess-worker` share
 * ONE implementation. This wrapper is still deployed and may still be
 * invoked by database webhooks; the durable job ledger is replacing
 * trigger-inline invocation, after which this can be retired.
 *
 * Behaviour preserved from the previous inline implementation:
 *   - request shape { type, record } from database webhooks;
 *   - response shapes { success, url } / { success, error };
 *   - admin error email (Resend) for unexpected failures, suppressed for
 *     expected data-quality failures (ImageFormatError and the new terminal
 *     data-quality classes — same rationale: they need a source URL fix,
 *     not a function fix).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import {
  generateCorrelationId,
  logError,
  logInfo,
} from "../_shared/monitoring.ts";
import { ensureImageMagickReady } from "../_shared/magick-init.ts";
import {
  fetchLogoWithGuards,
  MIRROR_BUCKET,
  MirrorCoreDeps,
  mirrorRoasterLogo,
  realImageEncoders,
} from "../_shared/roaster-logo-mirror-core.ts";
import {
  DbError,
  errorToMessage,
  isExpectedDataQualityError,
} from "../_shared/roaster-postprocess-errors.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const ADMIN_EMAIL = Deno.env.get("ADMIN_EMAIL");

if (
  !supabaseUrl || !supabaseServiceRoleKey || !RESEND_API_KEY || !ADMIN_EMAIL
) {
  throw new Error("Required environment variables are not set");
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

const mirrorDeps: MirrorCoreDeps = {
  fetchLogo: fetchLogoWithGuards,
  encoders: realImageEncoders,
  ensureReady: ensureImageMagickReady,
  logger: {
    info: (message, details) =>
      logInfo(`[roaster-logo-mirror] ${message}`, details),
    warn: (message, details) => {
      console.warn(`[roaster-logo-mirror] ${message}`, details ?? {});
    },
  },
  uploadObject: async (path, bytes, contentType) => {
    const { error } = await supabase.storage.from(MIRROR_BUCKET).upload(
      path,
      bytes,
      { contentType, cacheControl: "31536000", upsert: true },
    );
    if (error) throw error; // core wraps into StorageUploadError
  },
  getPublicUrl: (path) =>
    supabase.storage.from(MIRROR_BUCKET).getPublicUrl(path).data.publicUrl,
  updateRoasterMirrorUrl: async (roasterId, url) => {
    const { error } = await supabase
      .from("coffee_roasters")
      .update({ roaster_logo_mirror_url: url })
      .eq("id", roasterId);
    if (error) {
      throw new DbError(
        `Failed to set roaster_logo_mirror_url: ${error.message}`,
      );
    }
  },
};

async function sendErrorEmail(subject: string, body: string): Promise<void> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: "logo_errors@timer.coffee",
        to: ADMIN_EMAIL,
        subject,
        html: body,
      }),
    });
    if (!res.ok) {
      console.error("Failed to send error email:", await res.text());
    }
  } catch (error) {
    console.error(
      "Error sending email:",
      error instanceof Error ? error.message : error,
    );
  }
}

Deno.serve(async (req) => {
  const correlationId = generateCorrelationId();

  let payload: { record?: Record<string, unknown>; type?: string };
  try {
    payload = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ success: false, error: "Invalid request" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const { record, type } = payload;

  // bigint ids may serialise as JSON numbers or numeric strings depending on
  // the webhook payload path — accept both.
  const recordId = typeof record?.id === "number"
    ? record.id
    : typeof record?.id === "string"
    ? Number(record.id)
    : NaN;

  if (
    (type === "INSERT" || type === "UPDATE") &&
    Number.isFinite(recordId) &&
    typeof record?.roaster_name === "string" &&
    typeof record?.roaster_logo_url === "string"
  ) {
    try {
      const result = await mirrorRoasterLogo(mirrorDeps, {
        roasterId: recordId,
        roasterName: record.roaster_name,
        logoUrl: record.roaster_logo_url,
      });
      logInfo("[roaster-logo-mirror] mirrored logo", {
        roaster_id: recordId,
        mirror_url: result.mirrorUrl,
        asset_kind: result.assetKind,
      });
      return new Response(
        JSON.stringify({ success: true, url: result.mirrorUrl }),
        { headers: { "Content-Type": "application/json" } },
      );
    } catch (error) {
      const errorMessage = errorToMessage(error);
      logError(
        "[roaster-logo-mirror] failed to process logo",
        error instanceof Error ? error : new Error(errorMessage),
        undefined,
        undefined,
        {
          roaster_id: recordId,
          logo_url: record.roaster_logo_url,
        },
      );

      // Expected data-quality issues (AVIF, auth-gated CDN HTML, oversized
      // sources, malformed URLs, SVG rasterisation unsupported) don't flood
      // the admin inbox — they need a source URL fix, not a function fix.
      if (!isExpectedDataQualityError(error)) {
        await sendErrorEmail(
          `Error processing roaster: ${record.roaster_name}`,
          `An error occurred while processing the logo for roaster ${record.roaster_name}:<br><br>
          Error message: ${errorMessage}<br>
          Roaster ID: ${recordId}<br>
          Logo URL: ${record.roaster_logo_url}`,
        );
      }

      return new Response(
        JSON.stringify({ success: false, error: errorMessage }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
  }

  return new Response(
    JSON.stringify({ success: false, error: "Invalid request" }),
    { headers: { "Content-Type": "application/json" } },
  );
});
