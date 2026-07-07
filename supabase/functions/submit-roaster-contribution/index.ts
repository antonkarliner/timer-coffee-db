// submit-roaster-contribution
// ────────────────────────────────────────────────────────────────
// Captures a user-submitted official website (and optional Instagram / city /
// country) for a roaster that is not yet in public.coffee_roasters, attaches it
// to the pending candidate cluster, and queues a fresh enrichment pass that will
// use the website as a high-confidence identity lead. Plan 011, Phase 1.
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

const BINARY_EXTENSIONS = [
  ".pdf", ".zip", ".rar", ".7z", ".tar", ".gz",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
];

// Structural-only website validation. Forces a scheme, rejects IP-literals /
// localhost / direct binary links. Returns the canonical URL or null.
function normalizeWebsiteUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s || s.length > 2048) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (!host || !host.includes(".")) return null; // require a real domain
  if (host === "localhost" || host.endsWith(".local")) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null; // bare IPv4 (SSRF hygiene)
  if (host.includes(":")) return null; // IPv6 literal
  const path = u.pathname.toLowerCase();
  if (BINARY_EXTENSIONS.some((ext) => path.endsWith(ext))) return null;
  u.hash = "";
  return u.toString();
}

function extractDomain(urlStr: string): string | null {
  try {
    return new URL(urlStr).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

// Accept a full Instagram URL or a bare handle (@name / name).
function normalizeInstagram(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 512) return null;
  if (/^https?:\/\//i.test(s) || s.includes(".")) {
    return normalizeWebsiteUrl(s);
  }
  const handle = s.replace(/^@/, "").replace(/[^A-Za-z0-9._]/g, "");
  if (!handle) return null;
  return `https://www.instagram.com/${handle}`;
}

function cleanText(raw: unknown, maxLen = 120): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

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

  const roaster = typeof body.roaster === "string" ? body.roaster.trim() : "";
  if (!roaster) {
    return json({ error: "Missing or invalid roaster" }, 400, cors);
  }

  const websiteUrl = normalizeWebsiteUrl(body.website_url);
  if (!websiteUrl) {
    return json({ error: "Invalid website_url" }, 400, cors);
  }
  const websiteDomain = extractDomain(websiteUrl);
  const instagramUrl = normalizeInstagram(body.instagram_url);
  const city = cleanText(body.city);
  const country = cleanText(body.country);

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
  if (clusterStatus !== "pending") {
    return json({ status: "not_pending", cluster_status: clusterStatus }, 200, cors);
  }

  // 5) Upsert the contribution (one per cluster + submitter).
  const nowIso = new Date().toISOString();
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
      },
      { onConflict: "cluster_id,submitted_by" },
    )
    .select("id")
    .single();

  if (upsertErr) {
    console.error("contribution upsert failed:", upsertErr);
    return json({ error: upsertErr.message }, 500, cors);
  }

  // 6) Ensure an enrichment pass is queued so the worker re-runs with the new
  //    website signal. Skip if one is already queued/running for this cluster.
  const { data: activeJobs, error: jobQueryErr } = await supabase
    .schema("service")
    .from("roaster_enrichment_jobs")
    .select("id")
    .eq("cluster_id", clusterId)
    .in("state", ["queued", "running"])
    .limit(1);

  if (jobQueryErr) {
    console.error("enrichment job lookup failed:", jobQueryErr);
  } else if (!activeJobs || activeJobs.length === 0) {
    const { error: jobInsertErr } = await supabase
      .schema("service")
      .from("roaster_enrichment_jobs")
      .insert({
        cluster_id: clusterId,
        state: "queued",
        stage: "triage",
        run_after: nowIso,
      });
    if (jobInsertErr) {
      console.error("enrichment job enqueue failed:", jobInsertErr);
    }
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
