// submit-roaster-contribution
// ────────────────────────────────────────────────────────────────
// Captures a user-submitted official website or Instagram profile (plus
// optional city / country) for a roaster that is not yet in
// public.coffee_roasters, attaches it to the pending candidate cluster, and
// queues a fresh enrichment pass that will use it as a high-confidence
// identity lead. Plan 011, Phase 1; URL routing per plan 030, step 2.
//
// A contribution needs at least one usable identity URL — a website OR an
// Instagram account profile. The shared classifier (_shared/roaster-url.ts)
// moves an Instagram URL out of the website field, deduplicates the same
// account across both fields, and rejects conflicting accounts.
//
// Auth: any signed-in user, including anonymous (the app always has at least an
// anonymous session). Rate-limited per user. Structural URL validation only —
// the human review gate stays the final arbiter, so a bad URL just degrades to a
// low-confidence card.
// ────────────────────────────────────────────────────────────────
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
import {
  checkUserRateLimit,
  createRateLimitResponse,
} from "../_shared/rate-limiter.ts";
import { parseContributionInput } from "./contribution-input.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false, detectSessionInUrl: false },
});

// Max contributions a single user may submit per rate-limit window.
const CONTRIBUTION_RATE_LIMIT = 20;

function json(
  body: Record<string, unknown>,
  status: number,
  cors: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req.headers.get("origin") ?? undefined);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, cors);
  }

  // 1) Resolve the caller. Anonymous users have a real JWT/uid via
  //    signInAnonymously; the bare anon key resolves to no user → 401.
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  let userId: string | null = null;
  if (token) {
    const { data: userData } = await supabase.auth.getUser(token);
    userId = userData?.user?.id ?? null;
  }
  if (!userId) {
    return json({ error: "Authentication required" }, 401, cors);
  }

  // 2) Rate limit per user.
  const rate = await checkUserRateLimit(userId, CONTRIBUTION_RATE_LIMIT);
  if (!rate.allowed) {
    return createRateLimitResponse(rate);
  }

  // 3) Parse + validate input.
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400, cors);
  }

  const parsedInput = parseContributionInput(body);
  if (!parsedInput.ok) {
    return json({ error: parsedInput.error }, parsedInput.status, cors);
  }
  const {
    roaster,
    website_url: websiteUrl,
    website_domain: websiteDomain,
    instagram_url: instagramUrl,
    city,
    country,
    routing,
  } = parsedInput.value;

  // 4) Resolve the target: already a known roaster? a pending cluster?
  const { data: target, error: targetErr } = await supabase.rpc(
    "roaster_contribution_target",
    { p_roaster: roaster },
  );
  if (targetErr) {
    console.error("roaster_contribution_target failed:", targetErr);
    return json({ error: targetErr.message }, 500, cors);
  }

  const matchedRoasterId = target?.matched_roaster_id ?? null;
  const clusterId: string | null = target?.cluster_id ?? null;
  const clusterStatus: string | null = target?.cluster_status ?? null;
  const normalizedName: string | null = target?.normalized_name ?? null;

  if (matchedRoasterId != null) {
    return json({ status: "already_known" }, 200, cors);
  }
  if (!clusterId || !normalizedName) {
    // Bean→candidate lag: the cluster does not exist yet. The app retries later.
    return json({ status: "no_cluster" }, 200, cors);
  }
  if (clusterStatus !== "pending" && clusterStatus !== "held") {
    return json(
      { status: "not_pending", cluster_status: clusterStatus },
      200,
      cors,
    );
  }

  // 5) Upsert the contribution (one per cluster + submitter). website_url is
  //    nullable: an Instagram-only contribution stores it as null (plan 030).
  const nowIso = new Date().toISOString();
  // When the router moved a URL between fields, record the decision in the
  // row's signals jsonb under url_routing. Merge with any existing signals
  // (the upsert replaces the row) instead of clobbering them.
  let signals: Record<string, unknown> | null = null;
  if (routing.routed) {
    const urlRouting = {
      routed: true,
      notes: routing.notes,
      submitted_website: typeof body.website_url === "string"
        ? body.website_url
        : null,
    };
    console.log(
      "roaster contribution url_routing:",
      JSON.stringify({ cluster_id: clusterId, ...urlRouting }),
    );
    const { data: existingRow } = await supabase
      .schema("service")
      .from("roaster_candidate_contributions")
      .select("signals")
      .eq("cluster_id", clusterId)
      .eq("submitted_by", userId)
      .maybeSingle();
    const existingSignals = existingRow?.signals &&
        typeof existingRow.signals === "object" &&
        !Array.isArray(existingRow.signals)
      ? existingRow.signals as Record<string, unknown>
      : {};
    signals = { ...existingSignals, url_routing: urlRouting };
  }
  const { data: contribution, error: upsertErr } = await supabase
    .schema("service")
    .from("roaster_candidate_contributions")
    .upsert(
      {
        cluster_id: clusterId,
        normalized_name: normalizedName,
        website_url: websiteUrl,
        website_domain: websiteDomain,
        instagram_url: instagramUrl,
        city,
        country,
        submitted_by: userId,
        source: "app_nudge",
        status: "new",
        updated_at: nowIso,
        ...(signals ? { signals } : {}),
      },
      { onConflict: "cluster_id,submitted_by" },
    )
    .select("id")
    .single();

  if (upsertErr) {
    console.error("contribution upsert failed:", upsertErr);
    return json({ error: upsertErr.message }, 500, cors);
  }

  // The DB locks the cluster before enqueueing. A hold remains in effect even
  // when it was applied after our target lookup; the contribution is preserved.
  const { error: enqueueError } = await supabase.schema("service").rpc(
    "enqueue_roaster_enrichment",
    { p_cluster_id: clusterId },
  );
  if (enqueueError) {
    console.error("enrichment job enqueue failed:", enqueueError);
  }

  return json(
    {
      status: "ok",
      cluster_id: clusterId,
      contribution_id: contribution?.id ?? null,
    },
    201,
    cors,
  );
});
