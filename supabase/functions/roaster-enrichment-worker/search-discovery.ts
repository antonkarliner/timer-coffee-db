export const SEARCH_POLICY_SOURCE = "worker_cluster_search_v2";
export const SEARCH_RESULT_LIMIT = 10;
export const CANDIDATE_URL_LIMIT = 6;

/**
 * Domains that may appear as discovery *leads* but must never be fetched as
 * evidence.
 *
 * These split into two groups that behave the same way here: social/UGC
 * (facebook, reddit, threads) and directory/broker pages (yelp, mapquest,
 * rocketreach). Both are useful for locating a roaster — a reddit thread
 * titled "coffee roasters in and around Adelaide" is often the only thing
 * that pins down a city — and both are unacceptable as proof of identity,
 * domain, or address, because anyone can write them.
 *
 * So their titles and snippets stay in `search_evidence` (the extract and
 * validate prompts already treat search metadata as "discovery leads, not
 * proof"), while `candidate_urls` excludes them so the fetch/parse budget is
 * spent only on pages that can actually establish a field.
 */
const LEAD_ONLY_DOMAINS = [
  // Social / user-generated
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "reddit.com",
  "threads.com",
  "threads.net",
  "youtube.com",
  // Directories, brokers, and review aggregators
  "yelp.com",
  "tripadvisor.com",
  "google.com",
  "foursquare.com",
  "mapquest.com",
  "rocketreach.co",
  "every.coffee",
  "directorioempresarialmexico.com",
  // Coffee editorial — reliable reading, but still not the roaster's own site
  "sprudge.com",
  "coffeereview.com",
];
const BINARY_EXTENSIONS =
  /\.(?:avif|bmp|docx?|gif|ico|jpe?g|mov|mp3|mp4|pdf|png|pptx?|svg|tiff?|webm|webp|xlsx?)(?:$|[?#])/i;

export interface SearchQuery {
  query: string;
  kind: "roaster_official" | "roaster_bean";
  bean_context: string | null;
}

export interface RawSearchResult {
  title?: string | null;
  link?: string | null;
  url?: string | null;
  snippet?: string | null;
  displayLink?: string | null;
  display_link?: string | null;
}

export interface DiscoveryResult {
  title: string | null;
  url: string;
  domain: string;
  snippet: string | null;
  query: string;
  query_kind: SearchQuery["kind"] | "user_contribution";
  rank: number;
  evidence_score: number;
  /**
   * True when the URL may be used as a discovery lead but must not be fetched
   * as evidence. Absent on user-contribution entries.
   */
  lead_only?: boolean;
  source: typeof SEARCH_POLICY_SOURCE | "user_contribution";
}

export interface SearchProvider {
  (query: SearchQuery): Promise<RawSearchResult[]>;
}

function compact(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function normalizeDiscoveryUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (BINARY_EXTENSIONS.test(url.pathname)) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function discoveryDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * True when `url` may only be used as a discovery lead, never fetched as
 * evidence. Kept exported under the old name so existing callers and tests
 * keep working.
 */
export function isAggregatorUrl(url: string): boolean {
  const domain = discoveryDomain(url);
  return LEAD_ONLY_DOMAINS.some((blocked) =>
    domain === blocked || domain.endsWith(`.${blocked}`)
  );
}

function meaningfulBeanContext(candidate: Record<string, unknown>): string {
  const source = typeof candidate.source_record === "object" &&
      candidate.source_record !== null
    ? candidate.source_record as Record<string, unknown>
    : {};
  return [candidate.coffee_bean_name, source.origin, source.region, source.farm]
    .map(compact)
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");
}

/**
 * Substrings that already mark a cluster name as coffee-related, in the
 * languages that actually show up in the candidate table.
 *
 * Used only to decide whether appending a generic anchor to the official
 * query is worth the words. A miss costs two redundant words in one search
 * query and nothing else — it can never change an extracted field — so this
 * is a cheap heuristic, not a semantic judgement about the name.
 */
const COFFEE_NAME_TOKENS = [
  "coffee",
  "caffe",
  "caffè",
  "cafe",
  "café",
  "kaffe",
  "kaffee",
  "koffie",
  "kava",
  "kawa",
  "kopi",
  "roast",
  "palarnia",
  "tostador",
  "tueste",
  "torref",
  "rosteri",
  "brygg",
  "咖啡",
  "コーヒー",
  "커피",
];

function nameCarriesCoffeeSignal(name: string): boolean {
  const haystack = name.toLocaleLowerCase();
  return COFFEE_NAME_TOKENS.some((token) => haystack.includes(token));
}

export function buildSearchQueries(
  clusterName: string,
  candidates: Record<string, unknown>[],
): SearchQuery[] {
  const name = compact(clusterName);
  if (!name) return [];

  // The old template was `"<name>" coffee roaster official`, which reliably
  // surfaced roasting-*equipment* vendors (IKAWA, Diedrich, ROEST, San
  // Franciscan). Two reasons, both fixed here:
  //
  //   * "coffee roaster" singular is the name of the machine; "coffee
  //     roasters" plural is how the businesses name themselves.
  //   * "official" matches every manufacturer's "official site" boilerplate
  //     while adding nothing for a keyword engine.
  //
  // The anchor is also dropped entirely when the name already says coffee,
  // so `"POGO Coffee Roasters"` searches for itself instead of competing
  // with two generic words.
  const officialQuery = nameCarriesCoffeeSignal(name)
    ? `\"${name}\"`
    : `\"${name}\" coffee roasters`;
  const queries: SearchQuery[] = [{
    query: officialQuery,
    kind: "roaster_official",
    bean_context: null,
  }];

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const context = meaningfulBeanContext(candidate);
    const key = context.toLocaleLowerCase();
    if (!context || seen.has(key)) continue;
    seen.add(key);
    // The bean context used to be quoted as an exact phrase. That made the
    // query unsatisfiable for any bean whose name is not written the way the
    // roaster's site writes it — which is most non-English beans, and is why
    // clusters like "Фильтр Эфиопия Ненсебо" returned zero bean evidence and
    // were sent to review for lacking it. The roaster name stays quoted
    // because it is the identity anchor; the bean terms are now loose.
    queries.push({
      query: `\"${name}\" ${context}`,
      kind: "roaster_bean",
      bean_context: context,
    });
    // Three queries instead of four. Each query contributes at most 5 raw
    // results against a SEARCH_RESULT_LIMIT of 10, so the fourth mostly added
    // ranking competition rather than kept results — and cutting it returns
    // ~25% of the daily Google CSE free-tier budget to the 1.7k-cluster
    // backlog.
    if (queries.length >= 3) break;
  }
  return queries;
}

function scoreResult(
  kind: SearchQuery["kind"],
  rank: number,
  domain: string,
  leadOnly: boolean,
): number {
  const queryBoost = kind === "roaster_bean" ? 35 : 20;
  const rankScore = Math.max(0, 12 - rank * 2);
  const roasterHint = /coffee|cafe|café|roast|kaffee|koffie|caffe/.test(domain)
    ? 5
    : 0;
  // Lead-only domains now stay in the evidence record, so they have to rank
  // below anything fetchable or a page of Yelp listings could crowd the real
  // roaster out of the SEARCH_RESULT_LIMIT slots.
  const leadPenalty = leadOnly ? 25 : 0;
  return queryBoost + rankScore + roasterHint - leadPenalty;
}

export async function discoverCandidateSources(options: {
  clusterName: string;
  candidates: Record<string, unknown>[];
  contributedWebsite?: string | null;
  search: SearchProvider;
}): Promise<{
  search_evidence: {
    source: typeof SEARCH_POLICY_SOURCE;
    results: DiscoveryResult[];
  };
  candidate_urls: string[];
  provider_failure_count: number;
}> {
  const ranked: DiscoveryResult[] = [];
  let providerFailureCount = 0;
  for (
    const query of buildSearchQueries(options.clusterName, options.candidates)
  ) {
    let rawResults: RawSearchResult[];
    try {
      rawResults = await options.search(query);
    } catch {
      rawResults = [];
      providerFailureCount++;
    }
    rawResults.slice(0, 5).forEach((result, index) => {
      const url = normalizeDiscoveryUrl(result.link ?? result.url);
      if (!url) return;
      const domain = discoveryDomain(url);
      if (!domain) return;
      // Lead-only results are kept here for their title and snippet, and
      // filtered out of candidate_urls below.
      const leadOnly = isAggregatorUrl(url);
      ranked.push({
        title: compact(result.title) || null,
        url,
        domain,
        snippet: compact(result.snippet) || null,
        query: query.query,
        query_kind: query.kind,
        rank: index + 1,
        evidence_score: scoreResult(query.kind, index + 1, domain, leadOnly),
        lead_only: leadOnly,
        source: SEARCH_POLICY_SOURCE,
      });
    });
  }
  ranked.sort((left, right) =>
    right.evidence_score - left.evidence_score || left.rank - right.rank
  );
  const results: DiscoveryResult[] = [];
  const seenUrls = new Set<string>();
  for (const result of ranked) {
    if (results.length >= SEARCH_RESULT_LIMIT || seenUrls.has(result.url)) {
      continue;
    }
    seenUrls.add(result.url);
    results.push(result);
  }
  const candidateUrls: string[] = [];
  const seenDomains = new Set<string>();
  const contributed = normalizeDiscoveryUrl(options.contributedWebsite);
  if (contributed && !isAggregatorUrl(contributed)) {
    candidateUrls.push(contributed);
    seenDomains.add(discoveryDomain(contributed));
  }
  for (const result of results) {
    // Leads inform the prompt but never spend a fetch.
    if (result.lead_only) continue;
    if (seenDomains.has(result.domain)) continue;
    candidateUrls.push(result.url);
    seenDomains.add(result.domain);
    if (candidateUrls.length >= CANDIDATE_URL_LIMIT) break;
  }
  return {
    search_evidence: { source: SEARCH_POLICY_SOURCE, results },
    candidate_urls: candidateUrls,
    provider_failure_count: providerFailureCount,
  };
}
