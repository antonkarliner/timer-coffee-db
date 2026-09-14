import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const dump = JSON.parse(readFileSync("scripts/roaster-review/dump-2026-08-22-top50.json", "utf8"));
const research = JSON.parse(readFileSync("scripts/roaster-review/research-2026-08-22-top50.json", "utf8"));
const reviewed = JSON.parse(readFileSync("scripts/roaster-review/reviewed-2026-08-23.json", "utf8"));
const cardByCluster = new Map(dump.cards.map((c) => [c.cluster_id, c]));

const usStates = { AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",DC:"District of Columbia",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming" };

const q = (s) => "'" + String(s ?? "").replace(/'/g, "''") + "'";
const norm = (s) => `lower(unaccent(${q(s)}))`;
const stringOrEmpty = (v) => String(v ?? "").trim();
const cleanUrl = (v) => { const s = stringOrEmpty(v); if (!s) return ""; if (s.startsWith("//")) return `https:${s}`; if (/^https?:\/\//i.test(s)) return s; if (/^([a-z0-9-]+\.)+[a-z]{2,}/i.test(s)) return `https://${s}`; return ""; };
const cleanLogoUrl = (v) => { const c = cleanUrl(v); return /\.(png|jpe?g|webp)(?:[?#].*)?$/i.test(c) ? c : ""; };
function normalizeAliases(aliases, own) {
  const ownN = normName(own);
  const seen = new Set(); const out = [];
  for (const a of stringOrEmpty(aliases).split(",")) {
    const c = stringOrEmpty(a); const n = normName(c);
    if (!c || !n || n === ownN || seen.has(n)) continue;
    seen.add(n); out.push(c);
  }
  return out.join(",");
}
function normName(v) { return stringOrEmpty(v).normalize("NFKD").replace(/\p{Diacritic}/gu, "").replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase(); }
function fullUsState(v) { const u = stringOrEmpty(v).toUpperCase(); return usStates[u] || stringOrEmpty(v); }

function mergedPayload(clusterId) {
  const card = cardByCluster.get(clusterId);
  const fresh = research[clusterId] || {};
  const proposed = card?.latest_enrichment?.proposed || {};
  const country = stringOrEmpty(proposed.country);
  let state = stringOrEmpty(proposed.state);
  state = /^united states$/i.test(country) ? fullUsState(state) : "";
  const payload = {
    roaster_name: stringOrEmpty(proposed.roaster_name),
    roaster_logo_url: cleanLogoUrl(proposed.roaster_logo_url),
    roaster_website_url: cleanUrl(proposed.roaster_website_url),
    aliases: normalizeAliases(proposed.aliases, proposed.roaster_name),
    city: stringOrEmpty(proposed.city),
    state,
    country,
    address_text: stringOrEmpty(proposed.address || proposed.address_text),
    ...Object.fromEntries(Object.entries(fresh.payload || {}).map(([k, v]) => [k, v])),
  };
  const contribution = card?.contributions?.[0] || {};
  payload.roaster_name = payload.roaster_name || stringOrEmpty(card?.cluster?.display_name);
  payload.roaster_website_url = payload.roaster_website_url || cleanUrl(contribution.website_url);
  payload.city = payload.city || stringOrEmpty(contribution.city);
  payload.country = payload.country || stringOrEmpty(contribution.country);
  return { payload, fresh };
}

function actionOf(entry) {
  const c = String(entry.comment || "").toLowerCase();
  if (c.startsWith("approve create")) return "create";
  if (c.startsWith("approve alias")) return "alias";
  if (c.startsWith("approve update")) return "update";
  if (c.startsWith("complete existing")) return "complete";
  if (c.startsWith("re-enrich") || c.startsWith("hold")) return "re_enrich";
  if (c.startsWith("reject")) return "reject";
  return null;
}

const decisions = Object.entries(reviewed)
  .map(([n, e]) => ({ card: Number(n), clusterId: e.cluster_id, action: actionOf(e), entry: e }))
  .filter((d) => d.action)
  .sort((a, b) => a.card - b.card);

const batchId = "2026-08-23";
const maintenanceMode = process.env.ROASTER_REVIEW_MAINTENANCE === "1";
const runRoasters = new Map();
const rememberRunRoaster = (selector, jobs) => {
  const key = selector.id != null ? `id:${selector.id}` : `normalized_name:${selector.normalized_name}`;
  const current = runRoasters.get(key) || { ...selector, expected_jobs: [] };
  current.expected_jobs = [...new Set([...current.expected_jobs, ...jobs])];
  runRoasters.set(key, current);
};

const out = [];
out.push("-- Timer.Coffee roaster review batch 2026-08-22 top50 — approved 2026-08-23");
out.push("-- Generated from reviewer-approved comments JSON. Idempotent: safe to re-run.");
out.push("-- Keeps durable post-processing enqueue triggers enabled by default.");
out.push("-- ROASTER_REVIEW_MAINTENANCE=1 temporarily disables them and explicitly enqueues equivalent durable jobs before commit.");
out.push("");
out.push("begin;");
out.push("");
if (maintenanceMode) {
  out.push("-- MAINTENANCE MODE: trigger bypass is paired with durable manual enqueue below.");
  // The legacy process_new/updated_coffee_roaster_logo triggers were dropped by
  // migration 20260914120200; the trigger to bypass is now the enqueue-only one.
  out.push("alter table public.coffee_roasters disable trigger trg_enqueue_roaster_logo_mirror;");
  out.push("alter table public.coffee_roasters disable trigger trg_attach_pending_global_beans;");
  out.push("");
}
out.push("------------------------------------------------------------------");
out.push("-- CREATES");
out.push("------------------------------------------------------------------");
const normNameByCard = new Map();
for (const d of decisions.filter((x) => x.action === "create")) {
  const { payload } = mergedPayload(d.clusterId);
  const final = { ...payload };
  if (d.entry.logo_override) final.roaster_logo_url = d.entry.logo_override.trim();
  if (d.card === 47) {
    final.roaster_name = "Riverside Coffee";
    final.aliases = normalizeAliases("RiverSide Coffee,Riverside", final.roaster_name);
  }
  if (!final.roaster_name || !final.roaster_logo_url) { out.push(`-- card ${d.card}: SKIPPED (missing name or logo)`); continue; }
  normNameByCard.set(d.card, final.roaster_name);
  rememberRunRoaster({ normalized_name: dbNormalizedName(final.roaster_name) }, ["mirror_logo", "extract_color", "attach_beans"]);
  out.push(`-- card ${d.card}: ${final.roaster_name}${d.entry.logo_override ? " (reviewer logo override)" : ""}`);
  out.push(`insert into public.coffee_roasters (roaster_name, roaster_logo_url, roaster_website_url, aliases, city, state, country, address_text)`);
  out.push(`select ${q(final.roaster_name)}, ${q(final.roaster_logo_url)}, ${final.roaster_website_url ? q(final.roaster_website_url) : "null"}, ${final.aliases ? q(final.aliases) : "null"}, ${final.city ? q(final.city) : "null"}, ${final.state ? q(final.state) : "null"}, ${final.country ? q(final.country) : "null"}, ${final.address_text ? q(final.address_text) : "null"}`);
  out.push(`where not exists (select 1 from public.coffee_roasters r where r.normalized_name = ${norm(final.roaster_name)});`);
  out.push("");
}
out.push("------------------------------------------------------------------");
out.push("-- UPDATE (card 19: Roast'd id 1601 — fill empty fields, add alias)");
out.push("------------------------------------------------------------------");
{
  const { payload } = mergedPayload("339d0575-19a9-4761-b3d8-5ea106418cf1");
  rememberRunRoaster({ id: 1601 }, ["mirror_logo", "extract_color", "attach_beans"]);
  out.push(`update public.coffee_roasters set`);
  out.push(`  city = coalesce(city, ${q(payload.city)}),`);
  out.push(`  state = coalesce(state, ${q(payload.state)}),`);
  out.push(`  country = coalesce(country, ${q(payload.country)}),`);
  out.push(`  address_text = coalesce(address_text, ${q(payload.address_text)}),`);
  out.push(`  roaster_logo_url = coalesce(roaster_logo_url, ${q(payload.roaster_logo_url)})`);
  out.push(`where id = 1601;`);
  out.push(`update public.coffee_roasters r`);
  out.push(`set aliases = coalesce(nullif(r.aliases, ''), '') || case when coalesce(r.aliases, '') = '' then '' else ',' end || 'Roast''d Coffee'`);
  out.push(`where r.id = 1601 and position(',' || lower(unaccent('Roast''d Coffee')) || ',' in ',' || coalesce(r.normalized_aliases, '') || ',') = 0;`);
  out.push("");
}
out.push("------------------------------------------------------------------");
out.push("-- ALIAS MERGES");
out.push("------------------------------------------------------------------");
for (const d of decisions.filter((x) => x.action === "alias")) {
  const { fresh } = mergedPayload(d.clusterId);
  const card = cardByCluster.get(d.clusterId);
  const alias = fresh.alias_to_add || card.cluster.display_name;
  rememberRunRoaster({ id: fresh.target_roaster_id }, ["attach_beans"]);
  out.push(`-- card ${d.card}: + "${alias}" -> id ${fresh.target_roaster_id} ${fresh.target_roaster_name}`);
  out.push(`update public.coffee_roasters r`);
  out.push(`set aliases = coalesce(nullif(r.aliases, ''), '') || case when coalesce(r.aliases, '') = '' then '' else ',' end || ${q(alias)}`);
  out.push(`where r.id = ${fresh.target_roaster_id}`);
  out.push(`  and position(',' || ${norm(alias)} || ',' in ',' || coalesce(r.normalized_aliases, '') || ',') = 0;`);
}
out.push("");
out.push("------------------------------------------------------------------");
out.push("-- CLUSTER CLOSURES + CANDIDATES");
out.push("------------------------------------------------------------------");
for (const d of decisions.filter((x) => x.action === "create")) {
  const name = normNameByCard.get(d.card);
  out.push(`update service.roaster_candidate_clusters c set status = 'approved', best_match_roaster_id = r.id`);
  out.push(`from public.coffee_roasters r where c.id = ${q(d.clusterId)} and r.normalized_name = ${norm(name)};`);
}
{
  out.push(`update service.roaster_candidate_clusters set status = 'approved', best_match_roaster_id = 1601 where id = '339d0575-19a9-4761-b3d8-5ea106418cf1';`);
  for (const d of decisions.filter((x) => x.action === "alias")) {
    const { fresh } = mergedPayload(d.clusterId);
    out.push(`update service.roaster_candidate_clusters set status = 'processed_as_alias', best_match_roaster_id = ${fresh.target_roaster_id} where id = ${q(d.clusterId)};`);
  }
  out.push(`-- card 48: complete existing against the row created by card 47`);
  out.push(`update service.roaster_candidate_clusters c set status = 'processed_as_alias', best_match_roaster_id = r.id`);
  out.push(`from public.coffee_roasters r where c.id = '526a9223-f0c8-4bcf-834c-dce273cdff7d' and r.normalized_name = ${norm("Riverside Coffee")};`);
}
out.push("");
out.push(`update service.new_roaster_candidates set processed = true`);
out.push(`where cluster_id in (${decisions.filter((d) => d.action !== "re_enrich").map((d) => q(d.clusterId)).join(", ")});`);
out.push("");
out.push("------------------------------------------------------------------");
out.push("-- RE-ENRICH JOBS: backfill prior_result_id (cards 31, 46, 50)");
out.push("------------------------------------------------------------------");
for (const d of decisions.filter((x) => x.action === "re_enrich")) {
  out.push(`update service.roaster_enrichment_jobs j set prior_result_id = (`);
  out.push(`  select res.id from service.roaster_enrichment_results res where res.cluster_id = ${q(d.clusterId)} order by res.updated_at desc limit 1`);
  out.push(`) where j.cluster_id = ${q(d.clusterId)} and j.prior_result_id is null;`);
}
out.push("");
if (maintenanceMode) {
  out.push("------------------------------------------------------------------");
  out.push("-- MAINTENANCE MODE DURABLE REPLAY");
  out.push("------------------------------------------------------------------");
  for (const roaster of runRoasters.values()) {
    const relation = roaster.id != null
      ? `(select r.* from public.coffee_roasters r where r.id = ${roaster.id})`
      : `(select r.* from public.coffee_roasters r where r.normalized_name = ${q(roaster.normalized_name)})`;
    for (const kind of roaster.expected_jobs.filter((value) => value !== "extract_color")) {
      // source_revision must be byte-identical to what the enqueue triggers
      // write (migration 20260914120000/120100/120200), otherwise the
      // uniq_roaster_job_active dedupe never matches and we double-queue.
      const revision = kind === "mirror_logo"
        ? "r.roaster_logo_url"
        : "(coalesce(r.normalized_name, '') || '|' || coalesce(r.normalized_aliases, ''))";
      out.push(`select service.enqueue_roaster_job(r.id, ${q(kind)}, ${revision}, now(), false) from ${relation} r;`);
    }
  }
  out.push("alter table public.coffee_roasters enable trigger trg_enqueue_roaster_logo_mirror;");
  out.push("alter table public.coffee_roasters enable trigger trg_attach_pending_global_beans;");
  out.push("");
}
out.push("commit;");
out.push("");
out.push("------------------------------------------------------------------");
out.push("-- VERIFICATION (run after commit)");
out.push("------------------------------------------------------------------");
out.push(`select 'new_roasters' as check, count(*)::text as value from public.coffee_roasters r where r.normalized_name in (${[...normNameByCard.values()].map((n) => norm(n)).join(", ")});`);
out.push(`select 'approved_clusters' as check, count(*)::text as value from service.roaster_candidate_clusters where status = 'approved' and id in (${decisions.filter((x) => x.action === "create" || x.action === "update").map((d) => q(d.clusterId)).join(", ")});`);
out.push(`select 'alias_clusters' as check, count(*)::text as value from service.roaster_candidate_clusters where status = 'processed_as_alias' and id in (${decisions.filter((x) => x.action === "alias" || x.action === "complete").map((d) => q(d.clusterId)).join(", ")});`);
out.push(`select 'unprocessed_members' as check, count(*)::text as value from service.new_roaster_candidates where cluster_id in (${decisions.filter((d) => d.action !== "re_enrich").map((d) => q(d.clusterId)).join(", ")}) and processed = false;`);
out.push(`select 'profiles_for_new' as check, count(*)::text as value from public.roaster_profiles p join public.coffee_roasters r on r.id = p.coffee_roaster_id where r.normalized_name in (${[...normNameByCard.values()].map((n) => norm(n)).join(", ")});`);

mkdirSync("scripts/roaster-review/runs", { recursive: true });
writeFileSync(`scripts/roaster-review/runs/${batchId}.json`, JSON.stringify({
  batch_id: batchId,
  generated_at: new Date().toISOString(),
  roasters: [...runRoasters.values()],
}, null, 2) + "\n");
writeFileSync("scripts/roaster-review/apply-2026-08-23.sql", out.join("\n") + "\n");
console.log(`wrote scripts/roaster-review/apply-2026-08-23.sql (${out.length} lines, ${normNameByCard.size} creates)`);
console.log(`wrote scripts/roaster-review/runs/${batchId}.json (${runRoasters.size} affected roasters)`);

function dbNormalizedName(value) {
  return stringOrEmpty(value).normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}
