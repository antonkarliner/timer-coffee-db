export const SEARCH_POLICY_SOURCE = "worker_cluster_search_v2";
export const SEARCH_RESULT_LIMIT = 10;
export const CANDIDATE_URL_LIMIT = 6;

const AGGREGATOR_DOMAINS = [
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "yelp.com",
  "tripadvisor.com",
  "google.com",
  "foursquare.com",
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

export function isAggregatorUrl(url: string): boolean {
  const domain = discoveryDomain(url);
  return AGGREGATOR_DOMAINS.some((blocked) =>
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

export function buildSearchQueries(
  clusterName: string,
  candidates: Record<string, unknown>[],
): SearchQuery[] {
  const name = compact(clusterName);
  if (!name) return [];
  const queries: SearchQuery[] = [{
    query: `\"${name}\" coffee roaster official`,
    kind: "roaster_official",
    bean_context: null,
  }];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const context = meaningfulBeanContext(candidate);
    const key = context.toLocaleLowerCase();
    if (!context || seen.has(key)) continue;
    seen.add(key);
    queries.push({
      query: `\"${name}\" \"${context}\" coffee`,
      kind: "roaster_bean",
      bean_context: context,
    });
    if (queries.length >= 4) break;
  }
  return queries;
}

function scoreResult(
  kind: SearchQuery["kind"],
  rank: number,
  domain: string,
): number {
  const queryBoost = kind === "roaster_bean" ? 35 : 20;
  const rankScore = Math.max(0, 12 - rank * 2);
  const roasterHint = /coffee|cafe|café|roast|kaffee|koffie|caffe/.test(domain)
    ? 5
    : 0;
  return queryBoost + rankScore + roasterHint;
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
      if (!url || isAggregatorUrl(url)) return;
      const domain = discoveryDomain(url);
      if (!domain) return;
      ranked.push({
        title: compact(result.title) || null,
        url,
        domain,
        snippet: compact(result.snippet) || null,
        query: query.query,
        query_kind: query.kind,
        rank: index + 1,
        evidence_score: scoreResult(query.kind, index + 1, domain),
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
