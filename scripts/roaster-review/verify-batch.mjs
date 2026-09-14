import { readFileSync } from "node:fs";

const MAX_ROASTERS = 500;
const PAGE_SIZE = 100;
const runPath = process.argv[2];
if (!runPath) throw new Error("usage: node scripts/roaster-review/verify-batch.mjs scripts/roaster-review/runs/<batch-id>.json");

const run = JSON.parse(readFileSync(runPath, "utf8"));
if (!run.batch_id || !Array.isArray(run.roasters) || run.roasters.length === 0) throw new Error("run record must contain batch_id and non-empty roasters");
if (run.roasters.length > MAX_ROASTERS) throw new Error(`run record exceeds bounded maximum of ${MAX_ROASTERS} roasters`);
for (const roaster of run.roasters) {
  if ((roaster.id == null) === (roaster.normalized_name == null)) throw new Error("each run-record roaster needs exactly one of id or normalized_name");
  if (!Array.isArray(roaster.expected_jobs) || roaster.expected_jobs.length === 0) throw new Error("each run-record roaster needs expected_jobs");
}

const env = readEnv("supabase/.env.local");
const supabaseUrl = env.SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) throw new Error("missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");

async function request(schema, resource, { method = "GET", params, body } = {}) {
  const url = new URL(`${supabaseUrl}/rest/v1/${resource}`);
  if (params) url.search = params.toString();
  const response = await fetch(url, {
    method,
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      "accept-profile": schema,
      "content-profile": schema,
      "content-type": "application/json",
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${schema}.${resource} ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : [];
}

async function boundedPages(schema, resource, baseParams, maximumRows) {
  const rows = [];
  for (let offset = 0; offset < maximumRows; offset += PAGE_SIZE) {
    const limit = Math.min(PAGE_SIZE, maximumRows - offset);
    const params = new URLSearchParams(baseParams);
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    const page = await request(schema, resource, { params });
    rows.push(...page);
    if (page.length < limit) return rows;
  }
  const overflow = new URLSearchParams(baseParams);
  overflow.set("limit", "1");
  overflow.set("offset", String(maximumRows));
  if ((await request(schema, resource, { params: overflow })).length) {
    throw new Error(`${schema}.${resource} exceeded explicit ${maximumRows}-row verification bound`);
  }
  return rows;
}

const explicitIds = run.roasters.filter((r) => r.id != null).map((r) => Number(r.id));
const names = run.roasters.filter((r) => r.normalized_name != null).map((r) => String(r.normalized_name));
const selectors = [];
if (explicitIds.length) selectors.push(`id.in.(${explicitIds.join(",")})`);
if (names.length) selectors.push(`normalized_name.in.(${names.map(postgrestQuote).join(",")})`);
const roasterParams = new URLSearchParams({
  select: "id,roaster_name,normalized_name,roaster_logo_url,roaster_logo_mirror_url,dominant_color_hex",
  or: `(${selectors.join(",")})`,
});
const roasters = await boundedPages("public", "coffee_roasters", roasterParams, run.roasters.length);
const byId = new Map(roasters.map((r) => [Number(r.id), r]));
const byName = new Map(roasters.map((r) => [r.normalized_name, r]));
const unresolved = run.roasters.filter((r) => !(r.id != null ? byId.has(Number(r.id)) : byName.has(r.normalized_name)));
const resolved = run.roasters.map((r) => ({ spec: r, row: r.id != null ? byId.get(Number(r.id)) : byName.get(r.normalized_name) })).filter((x) => x.row);
const batchIds = [...new Set(resolved.map((x) => Number(x.row.id)))];

const profileParams = new URLSearchParams({ select: "coffee_roaster_id", coffee_roaster_id: `in.(${batchIds.join(",")})` });
const profiles = batchIds.length ? await boundedPages("public", "roaster_profiles", profileParams, batchIds.length) : [];
const profileIds = new Set(profiles.map((p) => Number(p.coffee_roaster_id)));
const missingProfiles = batchIds.filter((id) => !profileIds.has(id));
const sourceWithoutMirror = roasters.filter((r) => r.roaster_logo_url != null && r.roaster_logo_mirror_url == null).map((r) => Number(r.id));
const mirrorWithoutColor = roasters.filter((r) => r.roaster_logo_mirror_url != null && r.dominant_color_hex == null).map((r) => Number(r.id));

const jobParams = new URLSearchParams({
  select: "id,roaster_id,kind,source_revision,state,attempts,max_attempts,run_after,locked_by,locked_at,last_error,error_class,correlation_id,created_at,updated_at,finished_at",
  roaster_id: `in.(${batchIds.join(",")})`,
  order: "id.asc",
});
const maximumJobs = Math.max(1, batchIds.length * 100);
const jobs = batchIds.length ? await boundedPages("service", "roaster_postprocess_jobs", jobParams, maximumJobs) : [];
const outstanding = jobs.filter((j) => ["queued", "running", "retry_wait"].includes(j.state));
const failed = jobs.filter((j) => j.state === "failed");
const missingSucceeded = [];
for (const { spec, row } of resolved) {
  for (const kind of spec.expected_jobs) {
    if (!jobs.some((job) => Number(job.roaster_id) === Number(row.id) && job.kind === kind && job.state === "succeeded")) {
      missingSucceeded.push({ roaster_id: Number(row.id), kind });
    }
  }
}

const reconcileParams = new URLSearchParams({
  select: "violation,roaster_id,detail",
  roaster_id: `in.(${batchIds.join(",")})`,
  order: "roaster_id.asc",
});
const reconciliation = batchIds.length
  ? await boundedRpc("reconcile_roaster_postprocessing", { p_enqueue: false }, reconcileParams, Math.max(1, batchIds.length * 10))
  : [];

printIds("unresolved_run_entries", unresolved.map((r) => r.id ?? r.normalized_name));
printIds("missing_profiles", missingProfiles);
printIds("source_without_mirror", sourceWithoutMirror);
printIds("mirror_without_color", mirrorWithoutColor);
console.log(`outstanding_jobs: count=${outstanding.length} ids=${JSON.stringify(outstanding.map((j) => j.id))}`);
console.log(`failed_jobs: count=${failed.length} ids=${JSON.stringify(failed.map((j) => j.id))}`);
for (const job of failed) console.log(`  failed job=${job.id} roaster=${job.roaster_id} kind=${job.kind} error_class=${JSON.stringify(job.error_class)} last_error=${JSON.stringify(job.last_error)}`);
console.log(`expected_jobs_without_success: count=${missingSucceeded.length} entries=${JSON.stringify(missingSucceeded)}`);
console.log(`reconciliation_violations: count=${reconciliation.length} roaster_ids=${JSON.stringify([...new Set(reconciliation.map((r) => Number(r.roaster_id)))])}`);
for (const row of reconciliation) console.log(`  ${row.violation} roaster=${row.roaster_id} detail=${JSON.stringify(row.detail)}`);

const hasFailure = unresolved.length || missingProfiles.length || sourceWithoutMirror.length || mirrorWithoutColor.length || outstanding.length || failed.length || missingSucceeded.length || reconciliation.length;
process.exitCode = hasFailure ? 1 : 0;

async function boundedRpc(name, body, baseParams, maximumRows) {
  const rows = [];
  for (let offset = 0; offset < maximumRows; offset += PAGE_SIZE) {
    const limit = Math.min(PAGE_SIZE, maximumRows - offset);
    const params = new URLSearchParams(baseParams);
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    const page = await request("service", `rpc/${name}`, { method: "POST", params, body });
    rows.push(...page);
    if (page.length < limit) return rows;
  }
  const overflow = new URLSearchParams(baseParams);
  overflow.set("limit", "1");
  overflow.set("offset", String(maximumRows));
  if ((await request("service", `rpc/${name}`, { method: "POST", params: overflow, body })).length) throw new Error(`service.${name} exceeded explicit ${maximumRows}-row verification bound`);
  return rows;
}

function printIds(label, ids) {
  console.log(`${label}: count=${ids.length} ids=${JSON.stringify(ids)}`);
}

function postgrestQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function readEnv(path) {
  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}
