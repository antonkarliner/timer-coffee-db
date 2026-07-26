import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const generatedAt = "2026-07-08";
const batchId = "2026-07-08-top50";
const outFile = `review-previews/roaster-candidate-review-${batchId}.html`;
const sourceMapFile = `review-previews/roaster-candidate-review-${batchId}-sources.json`;
const env = readEnv("supabase/.env.local");
const supabaseUrl = env.SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in supabase/.env.local");
}

const usStates = new Map(Object.entries({
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas",
  KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts",
  MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico",
  NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
}));

const activeJobStates = new Set(["queued", "processing", "running", "locked", "in_progress"]);
const placeholderNames = new Set(["none", "n/a", "na", "null", "test", "unknown", "roaster", "coffee", "cafe"]);

mkdirSync("review-previews", { recursive: true });

const contributionRows = await fetchRows("service", "roaster_candidate_contributions", new URLSearchParams({
  select: "id,cluster_id,normalized_name,website_url,instagram_url,city,country,submitted_by,source,status,signals,created_at",
  order: "created_at.desc",
  limit: "300",
})).catch((error) => {
  console.warn(`Skipping contribution priority: ${error.message}`);
  return [];
});

const contributionIds = unique(contributionRows.map((row) => row.cluster_id));
const contributionClusters = contributionIds.length
  ? await fetchChunked("service", "roaster_candidate_clusters", contributionIds, "id,normalized_name,display_name,sample_names,candidate_count,occurrences,status,confidence,best_match_roaster_id,updated_at", "updated_at.desc", "id")
  : [];

const volumeClusters = await fetchRows("service", "roaster_candidate_clusters", new URLSearchParams({
  select: "id,normalized_name,display_name,sample_names,candidate_count,occurrences,status,confidence,best_match_roaster_id,updated_at",
  status: "eq.pending",
  order: "candidate_count.desc,occurrences.desc,updated_at.desc",
  limit: "180",
}));
const contributionByCluster = groupBy(contributionRows, "cluster_id");
const clusters = mergeClusters(contributionClusters, volumeClusters)
  .filter((cluster) => cluster.status === "pending")
  .sort((a, b) => clusterPriority(a, b, contributionByCluster));

const clusterIds = clusters.map((row) => row.id);
const [jobs, results] = await Promise.all([
  fetchChunked("service", "roaster_enrichment_jobs", clusterIds, "cluster_id,id,state,stage,attempts,run_after,locked_at,locked_by,last_error,created_at,reviewer_notes,rejection_reason,prior_result_id", "created_at.desc"),
  fetchChunked("service", "roaster_enrichment_results", clusterIds, "cluster_id,id,status,proposed,sources,signals,confidence,error,updated_at,created_at,potential_matches", "updated_at.desc"),
]);

const latestJob = firstBy(jobs, "cluster_id");
const latestResult = firstBy(results, "cluster_id");
const eligible = clusters
  .filter((cluster) => {
    const job = latestJob.get(cluster.id);
    return !job || !activeJobStates.has(String(job.state || "").toLowerCase());
  })
  .slice(0, 50);

const selectedIds = eligible.map((row) => row.id);
const [candidates, roasters] = await Promise.all([
  fetchChunked("service", "new_roaster_candidates", selectedIds, "id,cluster_id,roaster,coffee_bean_name,location,processed,notes,google_search_results,bean_search_results,inserted_at,priority_score", "inserted_at.desc"),
  fetchRows("public", "coffee_roasters", new URLSearchParams({
    select: "id,roaster_name,aliases,normalized_name,normalized_aliases,city,state,country,address_text,roaster_logo_url,roaster_website_url",
    order: "id.asc",
    limit: "5000",
  })),
]);

const candidatesByCluster = groupBy(candidates, "cluster_id");
const sourceMap = {};
const cards = eligible.map((cluster, index) => {
  const result = latestResult.get(cluster.id);
  const job = latestJob.get(cluster.id);
  const rawRows = candidatesByCluster.get(cluster.id) || [];
  const contributions = contributionByCluster.get(cluster.id) || [];
  const card = buildCard(index + 1, cluster, result, job, rawRows, roasters, contributions);
  sourceMap[cluster.id] = card.sources;
  return card;
});

const batchDuplicates = findBatchDuplicates(cards);
for (const [clusterId, note] of batchDuplicates) {
  const card = cards.find((item) => item.cluster_id === clusterId);
  if (card) card.duplicate = `${card.duplicate} Batch duplicate check: ${note}`;
}

const counts = cards.reduce((acc, card) => {
  acc[card.recommendation] = (acc[card.recommendation] || 0) + 1;
  return acc;
}, {});

writeFileSync(sourceMapFile, JSON.stringify(sourceMap, null, 2));
writeFileSync(outFile, renderHtml(cards, counts));
console.log(outFile);

function buildCard(cardNo, cluster, result, job, rawRows, roasters, contributions) {
  const proposed = result?.proposed || {};
  const title = proposed.roaster_name || cluster.display_name || cluster.normalized_name;
  const payload = normalizePayload(proposed);
  const beanNames = unique(rawRows.map((row) => row.coffee_bean_name).filter(Boolean)).slice(0, 5);
  const domains = collectDomains(result, rawRows).slice(0, 10);
  const sources = collectSources(result, payload, contributions);
  const duplicateResult = duplicateCheck(cluster, payload, roasters);
  const quality = assessQuality(cluster, result, job, rawRows, payload, duplicateResult);
  const representativeRows = rawRows.slice(0, 5).map((row) => ({
    id: row.id,
    roaster: row.roaster,
    coffee_bean_name: row.coffee_bean_name,
    location: locationText(row.location),
    inserted_at: row.inserted_at,
  }));
  const evidence = [
    contributions.length ? `User-submitted: ${contributions.map(contributionText).join("; ")}` : "",
    beanNames.length ? `Bean-name cross-search: ${beanNames.join(", ")}` : "Bean-name cross-search: no usable bean names in raw rows",
    domains.length ? `Query/result domains checked: ${domains.join(", ")}` : "Query/result domains checked: no stored search-result domains",
    rawRows.length ? `Representative raw rows: ${representativeRows.map((row) => `#${row.id} ${row.roaster} / ${row.coffee_bean_name}`).join("; ")}` : "Representative raw rows: none returned",
  ].filter(Boolean);
  const notes = [
    quality.note,
    logoNote(payload, sources),
    result?.signals?.validation?.notes ? `Validation: ${result.signals.validation.notes}` : "",
    result?.signals?.extraction?.conflicts?.length ? `Conflicts: ${result.signals.extraction.conflicts.join(" ")}` : "",
    job?.reviewer_notes ? `Prior reviewer notes: ${job.reviewer_notes}` : "",
  ].filter(Boolean).join(" ");

  return {
    card: cardNo,
    cluster_id: cluster.id,
    title,
    candidate_count: cluster.candidate_count,
    occurrences: cluster.occurrences,
    recommendation: quality.recommendation,
    confidence: quality.confidence,
    payload,
    user_submitted: contributions.map((row) => ({
      website_url: row.website_url,
      instagram_url: row.instagram_url,
      city: row.city,
      country: row.country,
      created_at: row.created_at,
      source: row.source,
      status: row.status,
      signals: row.signals,
    })),
    evidence,
    representative_rows: representativeRows,
    sources,
    duplicate: duplicateResult.note,
    notes,
    re_enrich_reason: quality.re_enrich_reason || "",
    re_enrich_notes: quality.re_enrich_notes || "",
  };
}

function assessQuality(cluster, result, job, rawRows, payload, duplicateResult) {
  const normalizedCluster = normalizeName(cluster.display_name || cluster.normalized_name);
  const proposedIsRoaster = result?.proposed?.is_roaster;
  const confidence = Number(result?.confidence || 0);
  const hasLocation = Boolean(payload.city && payload.country);
  const hasLogo = acceptableLogo(payload.roaster_logo_url);
  const hasWebsite = Boolean(payload.roaster_website_url);
  const validationNeedsReview = result?.signals?.validation?.needs_review === true;
  const conflicts = result?.signals?.extraction?.conflicts || [];
  const resultStatus = result?.status || "missing";

  if (placeholderNames.has(normalizedCluster) || rawRows.every((row) => placeholderNames.has(normalizeName(row.roaster)))) {
    return {
      recommendation: "reject",
      confidence: "Reject placeholder/noise candidate.",
      note: "Raw roaster value is a placeholder or non-brand value.",
    };
  }

  if (duplicateResult.kind === "exact_existing") {
    const alias = usefulAlias(cluster.display_name, duplicateResult.match);
    if (alias) {
      return {
        recommendation: "approve alias",
        confidence: `Clear existing roaster match: ${duplicateResult.match.roaster_name}; proposed alias ${alias}.`,
        note: `Executable action should add alias ${alias} and mark the cluster processed_as_alias.`,
      };
    }
    return {
      recommendation: "complete existing",
      confidence: `Clear existing roaster match: ${duplicateResult.match.roaster_name}; no useful row mutation identified.`,
      note: "Close the cluster as existing without changing the roaster row.",
    };
  }

  if (String(proposedIsRoaster) === "false" && !hasWebsite) {
    return {
      recommendation: "reject",
      confidence: "Enrichment says this is not a roaster and no stronger official roaster identity is present.",
      note: "Reject as not a roaster unless the reviewer has outside evidence.",
    };
  }

  if (!result || resultStatus === "error") {
    return hold("other", "No usable enrichment result is available; rerun enrichment with raw candidate and bean evidence.", "No current enrichment result could support a create/update decision.");
  }

  if (!hasLogo) {
    return hold("logo_missing", `Identity appears to be ${payload.roaster_name || cluster.display_name}, but no acceptable PNG/JPG/WebP logo URL was verified. Search official site/social sources before create.`, "Logo is missing or not policy-compliant.");
  }

  if (!hasLocation) {
    return hold("other", `Recover verified city and country for ${payload.roaster_name || cluster.display_name}; current payload is not create-ready.`, "Create is blocked because city/country are not both verified.");
  }

  if (validationNeedsReview || conflicts.length > 0 || confidence < 0.72) {
    const reason = locationConflict(conflicts) ? "location_mismatch" : "ambiguous_identity";
    return hold(reason, `Resolve ${payload.roaster_name || cluster.display_name} using raw rows and bean-name search; current evidence has conflicts or low confidence.`, "Evidence has conflicts or enrichment explicitly requested review.");
  }

  if (!hasWebsite && confidence < 0.85) {
    return hold("ambiguous_identity", `Find an official website or profile for ${payload.roaster_name || cluster.display_name}; current evidence is not strong enough for create.`, "Website/profile evidence is too weak for a create.");
  }

  return {
    recommendation: "approve create",
    confidence: "Identity, logo, and city/country are coherent enough for a create proposal.",
    note: "Run final duplicate/payload validation before writing if approved.",
  };
}

function hold(re_enrich_reason, re_enrich_notes, note) {
  return {
    recommendation: "hold / re-enrich",
    confidence: note,
    note,
    re_enrich_reason,
    re_enrich_notes,
  };
}

function normalizePayload(proposed) {
  const country = stringOrEmpty(proposed.country);
  const isUs = /^united states$/i.test(country);
  let state = stringOrEmpty(proposed.state);
  if (isUs) state = fullUsState(state);
  else state = "";

  return {
    roaster_name: stringOrEmpty(proposed.roaster_name),
    roaster_logo_url: cleanLogoUrl(proposed.roaster_logo_url),
    roaster_website_url: cleanUrl(proposed.roaster_website_url),
    aliases: normalizeAliases(proposed.aliases, proposed.roaster_name),
    city: stringOrEmpty(proposed.city),
    state,
    country,
    address_text: stringOrEmpty(proposed.address || proposed.address_text),
  };
}

function duplicateCheck(cluster, payload, roasters) {
  const nameKey = normalizeName(payload.roaster_name || cluster.display_name);
  const clusterKey = normalizeName(cluster.display_name || cluster.normalized_name);
  const payloadDomain = registrableDomain(payload.roaster_website_url);
  const matches = [];

  for (const roaster of roasters) {
    const roasterName = normalizeName(roaster.roaster_name);
    const aliases = aliasList(roaster.aliases).map(normalizeName);
    const domain = registrableDomain(roaster.roaster_website_url);
    if (roasterName && (roasterName === nameKey || roasterName === clusterKey)) {
      matches.push({ kind: "name", roaster });
    } else if (aliases.includes(nameKey) || aliases.includes(clusterKey)) {
      matches.push({ kind: "alias", roaster });
    } else if (payloadDomain && domain && payloadDomain === domain && nameLikelyRelated(nameKey, roasterName)) {
      matches.push({ kind: "domain+name", roaster });
    }
  }

  if (matches.length > 0) {
    const first = matches[0];
    return {
      kind: "exact_existing",
      match: first.roaster,
      note: `Existing match considered: id ${first.roaster.id} ${first.roaster.roaster_name} (${first.kind}). Final verdict: do not create a duplicate.`,
    };
  }

  const domainOnly = payloadDomain
    ? roasters.find((roaster) => registrableDomain(roaster.roaster_website_url) === payloadDomain)
    : null;
  if (domainOnly) {
    return {
      kind: "domain_only",
      match: domainOnly,
      note: `Domain-only collision considered with id ${domainOnly.id} ${domainOnly.roaster_name}; not treated as an alias/update without a name match. Final verdict: no exact duplicate.`,
    };
  }

  return { kind: "none", match: null, note: "No exact name, alias, or strong website-domain duplicate found in current coffee_roasters." };
}

function findBatchDuplicates(cards) {
  const seenNames = new Map();
  const seenDomains = new Map();
  const notes = new Map();
  for (const card of cards) {
    const name = normalizeName(card.payload.roaster_name || card.title);
    const domain = registrableDomain(card.payload.roaster_website_url);
    if (name && seenNames.has(name)) {
      const other = seenNames.get(name);
      notes.set(card.cluster_id, `same proposed name as card ${other.card}.`);
      notes.set(other.cluster_id, `same proposed name as card ${card.card}.`);
    } else if (name) {
      seenNames.set(name, card);
    }
    if (domain && seenDomains.has(domain)) {
      const other = seenDomains.get(domain);
      notes.set(card.cluster_id, `same proposed domain ${domain} as card ${other.card}.`);
      notes.set(other.cluster_id, `same proposed domain ${domain} as card ${card.card}.`);
    } else if (domain) {
      seenDomains.set(domain, card);
    }
  }
  return notes;
}

async function fetchRows(schema, table, params) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
  url.search = params.toString();
  const response = await fetch(url, {
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      "accept-profile": schema,
    },
  });
  if (!response.ok) {
    throw new Error(`${schema}.${table} ${response.status}: ${await response.text()}`);
  }
  return await response.json();
}

async function fetchChunked(schema, table, ids, select, order, column = "cluster_id") {
  const chunks = [];
  for (let i = 0; i < ids.length; i += 35) chunks.push(ids.slice(i, i + 35));
  const all = [];
  for (const chunk of chunks) {
    const params = new URLSearchParams({
      select,
      [column]: `in.(${chunk.join(",")})`,
      order,
      limit: "5000",
    });
    all.push(...await fetchRows(schema, table, params));
  }
  return all;
}

function firstBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row[key])) map.set(row[key], row);
  }
  return map;
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row[key])) map.set(row[key], []);
    map.get(row[key]).push(row);
  }
  return map;
}

function collectSources(result, payload, contributions = []) {
  const out = [];
  const add = (url, kind = "source") => {
    const cleaned = cleanUrl(url);
    if (!cleaned || out.some((item) => item.url === cleaned)) return;
    out.push({ url: cleaned, kind });
  };
  add(payload.roaster_website_url, "website");
  add(payload.roaster_logo_url, "logo");
  for (const contribution of contributions) {
    add(contribution.website_url, "user-submitted website");
    add(contribution.instagram_url, "user-submitted instagram");
  }
  for (const source of result?.sources || []) add(source.url, "enrichment");
  return out;
}

function collectDomains(result, rawRows) {
  const domains = [];
  const add = (value) => {
    const domain = domainFromAny(value);
    if (domain && !domains.includes(domain)) domains.push(domain);
  };
  for (const source of result?.sources || []) add(source.url);
  for (const row of rawRows) {
    walkJson(row.google_search_results, add);
    walkJson(row.bean_search_results, add);
  }
  return domains;
}

function walkJson(value, visit) {
  if (!value) return;
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, visit);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) walkJson(item, visit);
  }
}

function locationText(location) {
  if (!location) return "";
  if (typeof location === "string") return location;
  return location.display_name || location.address || location.formatted_address || JSON.stringify(location);
}

function logoNote(payload, sources) {
  if (!payload.roaster_logo_url) return "Logo source quality: no acceptable official logo found.";
  const logoDomain = domainFromAny(payload.roaster_logo_url);
  const websiteDomain = domainFromAny(payload.roaster_website_url);
  if (logoDomain && websiteDomain && logoDomain === websiteDomain) return "Logo source quality: official site logo/profile asset.";
  if (sources.some((source) => domainFromAny(source.url) === logoDomain)) return "Logo source quality: source-listed logo asset, verify attribution in preview.";
  return "Logo source quality: third-party or CDN logo asset, verify attribution before writing.";
}

function normalizeAliases(aliases, roasterName) {
  const raw = Array.isArray(aliases) ? aliases : stringOrEmpty(aliases).split(",");
  const own = normalizeName(roasterName);
  const seen = new Set();
  const out = [];
  for (const alias of raw) {
    const clean = stringOrEmpty(alias);
    const normalized = normalizeName(clean);
    if (!clean || !normalized || normalized === own || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(clean);
  }
  return out.join(",");
}

function aliasList(value) {
  return stringOrEmpty(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function usefulAlias(displayName, roaster) {
  const alias = stringOrEmpty(displayName);
  const normalized = normalizeName(alias);
  if (!alias || normalized === normalizeName(roaster.roaster_name)) return "";
  if (aliasList(roaster.aliases).map(normalizeName).includes(normalized)) return "";
  return alias;
}

function nameLikelyRelated(a, b) {
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a) || tokenOverlap(a, b) >= 0.5;
}

function tokenOverlap(a, b) {
  const aa = new Set(a.split(/\s+/).filter(Boolean));
  const bb = new Set(b.split(/\s+/).filter(Boolean));
  if (!aa.size || !bb.size) return 0;
  let shared = 0;
  for (const token of aa) if (bb.has(token)) shared++;
  return shared / Math.min(aa.size, bb.size);
}

function locationConflict(conflicts) {
  return conflicts.some((item) => /location|address|city|country|state/i.test(item));
}

function acceptableLogo(url) {
  return /\.(png|jpe?g|webp)(?:[?#].*)?$/i.test(stringOrEmpty(url));
}

function cleanLogoUrl(url) {
  const cleaned = cleanUrl(url);
  return acceptableLogo(cleaned) ? cleaned : "";
}

function cleanUrl(url) {
  const value = stringOrEmpty(url);
  if (!value) return "";
  if (value.startsWith("//")) return `https:${value}`;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^([a-z0-9-]+\.)+[a-z]{2,}/i.test(value)) return `https://${value}`;
  return "";
}

function domainFromAny(value) {
  const cleaned = cleanUrl(value);
  if (!cleaned) return "";
  try {
    return new URL(cleaned).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function registrableDomain(value) {
  const host = domainFromAny(value);
  if (!host) return "";
  const platformSuffixes = ["myshopify.com", "square.site", "wixsite.com", "webflow.io", "squarespace.com", "wordpress.com", "stores.style", "theshop.jp"];
  if (platformSuffixes.some((suffix) => host.endsWith(`.${suffix}`))) return host;
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const publicSuffix2 = new Set(["co.uk", "com.au", "com.br", "com.tr", "co.za", "co.nz", "co.jp", "com.sg", "com.my", "com.ph", "com.hk", "co.kr", "com.mx"]);
  const last2 = parts.slice(-2).join(".");
  if (publicSuffix2.has(last2)) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

function normalizeName(value) {
  return stringOrEmpty(value)
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}

function fullUsState(value) {
  const clean = stringOrEmpty(value);
  if (!clean) return "";
  const upper = clean.toUpperCase();
  return usStates.get(upper) || clean;
}

function stringOrEmpty(value) {
  return String(value ?? "").trim();
}

function unique(values) {
  return [...new Set(values.map((item) => stringOrEmpty(item)).filter(Boolean))];
}

function mergeClusters(...groups) {
  const map = new Map();
  for (const group of groups) {
    for (const cluster of group) {
      if (!map.has(cluster.id)) map.set(cluster.id, cluster);
    }
  }
  return [...map.values()];
}

function clusterPriority(a, b, contributionByCluster) {
  const ac = contributionByCluster.get(a.id) || [];
  const bc = contributionByCluster.get(b.id) || [];
  if (Boolean(ac.length) !== Boolean(bc.length)) return bc.length - ac.length;
  const at = latestContributionTime(ac);
  const bt = latestContributionTime(bc);
  if (at !== bt) return bt - at;
  if (Number(a.candidate_count || 0) !== Number(b.candidate_count || 0)) return Number(b.candidate_count || 0) - Number(a.candidate_count || 0);
  if (Number(a.occurrences || 0) !== Number(b.occurrences || 0)) return Number(b.occurrences || 0) - Number(a.occurrences || 0);
  return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
}

function latestContributionTime(rows) {
  return Math.max(0, ...rows.map((row) => Date.parse(row.created_at || "") || 0));
}

function contributionText(row) {
  const bits = [
    row.website_url ? `website ${row.website_url}` : "",
    row.instagram_url ? `instagram ${row.instagram_url}` : "",
    row.city || row.country ? `location ${[row.city, row.country].filter(Boolean).join(", ")}` : "",
    row.created_at ? `submitted ${row.created_at}` : "",
  ].filter(Boolean);
  return bits.join(", ");
}

function readEnv(path) {
  const out = {};
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    out[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return out;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function renderHtml(cards, counts) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Roaster Candidate Review - ${batchId}</title>
<style>
body{font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f6f4ef;color:#202020}
header{padding:28px 32px;background:#24231f;color:#fff}
main{max-width:1180px;margin:0 auto;padding:24px}
.summary{display:flex;gap:12px;flex-wrap:wrap;margin-top:14px}
.pill{border:1px solid #d8d0c0;background:#fff;border-radius:999px;padding:7px 10px;font-size:13px;color:#25231f}
.card{background:#fff;border:1px solid #ddd4c5;border-radius:8px;margin:18px 0;padding:18px;box-shadow:0 1px 1px rgba(0,0,0,.03)}
.top{display:grid;grid-template-columns:86px 1fr;gap:16px;align-items:start}
.logo{width:78px;height:78px;border:1px solid #ddd4c5;border-radius:6px;object-fit:contain;background:#fafafa}
h2{margin:0 0 8px;font-size:21px;letter-spacing:0}
h3{font-size:14px;margin:16px 0 8px;color:#5b4d39;text-transform:uppercase}
.badge{display:inline-block;padding:4px 8px;border-radius:6px;font-size:12px;font-weight:700;background:#eee4d3;color:#3b3123}
.approve{background:#d9efe0}.hold{background:#f8e1bf}.reject{background:#f0c8c2}.existing{background:#d9e6ef}
pre{white-space:pre-wrap;word-break:break-word;background:#282521;color:#f7f4ed;padding:12px;border-radius:6px;font-size:12px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
ul{margin:8px 0 0 20px;padding:0}
a{color:#69502a;text-decoration-thickness:1px;text-underline-offset:2px}
.sources{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.source-link{border:1px solid #d8d0c0;background:#fbf8f2;border-radius:999px;padding:6px 9px;font-size:12px;color:#4a3920;text-decoration:none;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.source-link:hover{background:#efe4d2}
textarea,input[type=url]{width:100%;box-sizing:border-box;border:1px solid #cfc5b4;border-radius:6px;padding:10px;font:inherit;background:#fff}
textarea{min-height:70px}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 8px}
button{border:1px solid #9e8c72;border-radius:6px;background:#fff;padding:8px 10px;cursor:pointer}
button:hover{background:#f0e8da}
#jsonBox{min-height:360px;width:100%;box-sizing:border-box;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.handoff{background:#fff;border:1px solid #ddd4c5;border-radius:8px;padding:16px;margin-top:24px}
@media(max-width:760px){main{padding:14px}.grid,.top{grid-template-columns:1fr}.logo{width:96px;height:96px}}
</style>
</head>
<body>
<header>
<h1>Roaster Candidate Review</h1>
<div>Generated ${generatedAt}. Batch: top 50 pending eligible clusters by candidate_count/occurrences. Clusters with active queued/running enrichment were skipped. No writes have been made.</div>
<div class="summary">${Object.entries(counts).map(([k, v]) => `<span class="pill">${esc(k)}: ${v}</span>`).join("")}</div>
</header>
<main>
${cards.map(renderCard).join("\n")}
<div class="handoff">
  <div class="actions">
    <button id="copyJson" type="button">Copy comments JSON</button>
    <button id="downloadJson" type="button">Download comments JSON</button>
    <button id="clearInputs" type="button">Clear saved review inputs</button>
    <span id="status"></span>
  </div>
  <textarea id="jsonBox" readonly></textarea>
</div>
</main>
<script>
const key = ${JSON.stringify(`roaster-review-${batchId}`)};
const cards = Array.from(document.querySelectorAll(".card")).map((el) => ({
  card: Number(el.dataset.card),
  cluster_id: el.dataset.clusterId,
  title: el.dataset.title,
  recommendation: el.dataset.recommendation,
}));
let saved = {};
try { saved = JSON.parse(localStorage.getItem(key) || "{}"); } catch (_) { saved = {}; }
function collect(){
  const out = {};
  for (const card of cards) {
    out[String(card.card)] = {
      card: card.card,
      cluster_id: card.cluster_id,
      title: card.title,
      recommendation: card.recommendation,
      comment: document.querySelector('[data-comment="' + card.card + '"]').value,
      logo_override: document.querySelector('[data-logo-override="' + card.card + '"]').value
    };
  }
  return out;
}
function render(){
  const out = collect();
  try { localStorage.setItem(key, JSON.stringify(out)); } catch (_) {}
  document.getElementById("jsonBox").value = JSON.stringify(out, null, 2);
}
for (const card of cards) {
  const row = saved[String(card.card)] || {};
  document.querySelector('[data-comment="' + card.card + '"]').value = row.comment || "";
  document.querySelector('[data-logo-override="' + card.card + '"]').value = row.logo_override || "";
}
document.addEventListener("input", (event) => {
  if (event.target.matches("textarea[data-comment],input[data-logo-override]")) render();
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  document.querySelector('[data-comment="' + button.dataset.card + '"]').value = button.dataset.action;
  render();
});
document.getElementById("copyJson").addEventListener("click", async () => {
  const box = document.getElementById("jsonBox");
  try {
    await navigator.clipboard.writeText(box.value);
    document.getElementById("status").textContent = "Copied.";
  } catch (_) {
    box.focus();
    box.select();
    document.getElementById("status").textContent = "Clipboard blocked. JSON selected for manual copy.";
  }
});
document.getElementById("downloadJson").addEventListener("click", () => {
  const blob = new Blob([document.getElementById("jsonBox").value], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "roaster-candidate-review-${batchId}-comments.json";
  a.click();
  URL.revokeObjectURL(a.href);
  document.getElementById("status").textContent = "Downloaded.";
});
document.getElementById("clearInputs").addEventListener("click", () => {
  if (!confirm("Clear saved review inputs for this preview?")) return;
  try { localStorage.removeItem(key); } catch (_) {}
  for (const el of document.querySelectorAll("textarea[data-comment],input[data-logo-override]")) el.value = "";
  render();
});
render();
</script>
</body>
</html>`;
}

function renderCard(card) {
  const cls = card.recommendation.includes("approve") ? "approve" : card.recommendation.includes("complete") ? "existing" : card.recommendation.includes("reject") ? "reject" : "hold";
  const logo = card.payload.roaster_logo_url || "";
  const links = card.sources.map((source) => ({ href: source.url, label: `${source.kind}: ${linkLabel(source.url)}` }));
  const payload = card.recommendation === "complete existing"
    ? { ...card.payload, action: "complete_existing", row_changes: "none" }
    : card.recommendation === "approve alias"
      ? { ...card.payload, action: "add_alias_then_processed_as_alias" }
      : card.payload;
  return `<section class="card" data-card="${card.card}" data-cluster-id="${esc(card.cluster_id)}" data-title="${esc(card.title)}" data-recommendation="${esc(card.recommendation)}">
  <div class="top">
    ${logo ? `<img class="logo" src="${esc(logo)}" alt="">` : `<div class="logo"></div>`}
    <div>
      <h2>${card.card}. ${esc(card.title)}</h2>
      <span class="badge ${cls}">${esc(card.recommendation)}</span>
      <span class="pill">candidate_count ${card.candidate_count}</span>
      <span class="pill">occurrences ${card.occurrences}</span>
      <p>${esc(card.confidence)}</p>
    </div>
  </div>
  <div class="grid">
    <div>
      <h3>Proposed Payload</h3>
      <pre>${esc(JSON.stringify(payload, null, 2))}</pre>
      ${card.user_submitted?.length ? `<h3>User-Submitted Contributions</h3><pre>${esc(JSON.stringify(card.user_submitted, null, 2))}</pre>` : ""}
      <h3>Representative Candidate Rows</h3>
      <pre>${esc(JSON.stringify(card.representative_rows, null, 2))}</pre>
    </div>
    <div>
      <h3>Evidence</h3>
      <ul>${card.evidence.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>
      <h3>Sources</h3>
      <div class="sources">${links.map((link) => `<a class="source-link" href="${esc(link.href)}" target="_blank" rel="noopener noreferrer">${esc(link.label)}</a>`).join("")}</div>
      <h3>Duplicate Check</h3>
      <p>${esc(card.duplicate)}</p>
      <h3>Agent Notes</h3>
      <p>${esc(card.notes)}</p>
      ${card.re_enrich_reason ? `<h3>Re-Enrichment</h3><pre>${esc(JSON.stringify({ re_enrich_reason: card.re_enrich_reason, re_enrich_notes: card.re_enrich_notes }, null, 2))}</pre>` : ""}
    </div>
  </div>
  <div class="actions">
    ${["approve create", "approve alias", "complete existing", "re-enrich", "reject"].map((action) => `<button type="button" data-action="${action}" data-card="${card.card}">${action}</button>`).join("")}
  </div>
  <label>Reviewer comments
    <textarea data-comment="${card.card}" placeholder="Add action or notes for card ${card.card}"></textarea>
  </label>
  <label>Logo override
    <input type="url" data-logo-override="${card.card}" placeholder="https://example.com/logo.png">
  </label>
</section>`;
}

function linkLabel(href) {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return href;
  }
}
