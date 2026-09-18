/**
 * Roaster linking for parse-coffee-label (plan 034 §2.2).
 *
 * After a label has been parsed, decide which catalog roaster
 * (public.coffee_roasters) the bag belongs to using the TypeSafe "Jev"
 * decision model, and log one evaluation row per decision to
 * service.jev_eval_roaster_link.
 *
 * Nothing user-visible changes by default: two service.feature_flags rows
 * control the behaviour and both default to off.
 *   - jev_roaster_link_shadow -> "shadow": decide + log in the background,
 *     response byte-identical, no roasterLink key added.
 *   - jev_roaster_link        -> "enforce": decide + log and attach
 *     result.roasterLink to the response. Enforce also logs, so the shadow
 *     evaluation stream continues under enforce.
 *
 * Measured facts that fixed the design (do not relitigate; a ~5,200-call
 * evaluation on production data settled these):
 * - Send up to 40 candidates (accuracy flat from 5 to 100 options).
 * - Threshold on probabilities[choice], never on `confidence` and never on a
 *   pooled number: link decisions and __none__ decisions are calibrated in
 *   opposite directions. Auto-link only at p >= 0.9 — precision is >0.99 from
 *   p >= 0.5, but when the true roaster is absent from the candidates (42% of
 *   real scans) p >= 0.9 halves false links versus 0.7. The 0.7-0.9 band is
 *   logged for a later alias-suggestion feature.
 * - Trigram retrieval only. No vector/embedding arm: it was never evaluated
 *   and would add an OpenAI embedding call to every scan.
 * - The rest of the parsed label goes into the Jev state — bean name, origin,
 *   region, variety, tasting notes disambiguate.
 *
 * The orchestrator is written for testability: its Supabase client and its
 * Jev function are injected, so tests stub both and run with no network.
 */

import {
  JEV_NONE_OPTION_KEY,
  type JevAskOptions,
  type JevChoiceAnswer,
  type JevChoiceQuestion,
  jevChoose as realJevChoose,
  withNoneOfTheAbove,
} from "../_shared/jev-client.ts";
import {
  ErrorCategory,
  ErrorSeverity,
  logError,
  logInfo,
  logWarning,
} from "../_shared/monitoring.ts";
import type { Json } from "../_shared/types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** feature_flags key: run the link decision in the background, log only. */
export const ROASTER_LINK_FLAG_SHADOW = "jev_roaster_link_shadow";
/** feature_flags key: attach the decision to the response (and log). */
export const ROASTER_LINK_FLAG_ENFORCE = "jev_roaster_link";

/**
 * Auto-link only at p >= 0.9 on probabilities[choice]. See the measured-facts
 * note in the module doc: precision is >0.99 from p >= 0.5, but the 0.9
 * threshold halves false links when the true roaster is absent from the
 * candidates.
 */
export const DEFAULT_LINK_THRESHOLD = 0.9;

/** Cap on candidates sent to Jev (accuracy is flat from 5 to 100 options). */
export const MAX_CANDIDATES = 40;

/** Retrieval floor: the RPC default of 0.65 would hide the 0.05-0.65 tail. */
export const MIN_CANDIDATE_CONFIDENCE = 0.05;

/**
 * Enforce mode serves a waiting user: retrieval + metadata + Jev together
 * must fit this budget or the decision is abandoned (returns null).
 */
export const ENFORCE_TOTAL_DEADLINE_MS = 800;

/** Shadow mode runs after the response is sent, so no one waits on it. */
export const SHADOW_JEV_TIMEOUT_MS = 3000;

export const ROASTER_LINK_JEV_INSTRUCTIONS =
  "The state is a coffee bag label read from a photo. Which roaster in the options roasted this coffee? Pick __none__ if the roaster that made this bag is not among the options, or if the roaster text is not a roaster name at all.";

export const ROASTER_LINK_NONE_DESCRIPTION =
  "None of these. The roaster that made this bag is not any of the roasters listed above, or the roaster text is not a roaster name.";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RoasterLinkMode = "off" | "shadow" | "enforce";

export type RoasterLinkEvalOutcome =
  | "linked"
  | "abstained"
  | "below_threshold"
  | "no_candidates"
  | "jev_failed"
  | "error";

/** One row of public.find_potential_roaster_matches, narrowed and typed. */
export interface CandidateRow {
  roasterId: number;
  roasterName: string;
  confidence: number;
}

/** Metadata for one coffee_roasters row, used to describe options to Jev. */
export interface RoasterMeta {
  roasterName: string | null;
  city: string | null;
  country: string | null;
  /** Comma-separated alias string as stored in coffee_roasters.aliases. */
  aliases: string | null;
}

/** A decided roaster link. Only ever attached to the response in enforce. */
export interface RoasterLink {
  roasterId: number;
  canonicalName: string;
  p: number;
  raw: string;
}

/** One row of service.feature_flags, as far as resolveMode cares. */
export interface RoasterLinkFlagRow {
  key: string;
  enabled: boolean | null;
}

/**
 * One row of service.jev_eval_roaster_link. Written exactly once per
 * runRoasterLink call, whatever the outcome, so fallback rates are measurable.
 * true_roaster_id / labelled_at stay null here; a human labeller fills them.
 */
export interface JevEvalRoasterLinkRow {
  correlation_id: string | null;
  mode: "shadow" | "enforce";
  outcome: RoasterLinkEvalOutcome;
  raw_roaster: string;
  roaster_brand_name: string | null;
  /** Exactly what was sent to Jev; null when Jev never ran. */
  jev_state: Record<string, string> | null;
  candidate_ids: number[] | null;
  trigram_top_id: number | null;
  trigram_top_conf: number | null;
  jev_choice: string | null;
  jev_p: number | null;
  jev_confidence: number | null;
  jev_probabilities: Record<string, number> | null;
  linked_roaster_id: number | null;
  latency_ms: number;
  true_roaster_id: null;
  labelled_at: null;
}

/** Minimal result envelope of the supabase-js postgrest builders we await. */
export interface RoasterLinkDbResult<T> {
  data: T | null;
  error: { message: string } | null;
}

/** One supabase-js table builder subset: select..in and insert. */
export interface RoasterLinkDbTable {
  select(
    columns: string,
  ): {
    in(
      column: string,
      values: (string | number)[],
    ): PromiseLike<RoasterLinkDbResult<Array<Record<string, unknown>>>>;
  };
  insert(
    row: Record<string, unknown>,
  ): PromiseLike<RoasterLinkDbResult<null>>;
}

/**
 * Minimal structural surface of the supabase-js client this module touches.
 * index.ts passes the real service-role client (cast once); tests pass a
 * hand-rolled stub, which is why the interface stays this small.
 */
export interface RoasterLinkDb {
  schema(schema: string): { from(table: string): RoasterLinkDbTable };
  from(table: string): RoasterLinkDbTable;
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<RoasterLinkDbResult<unknown>>;
}

/** Injectable dependencies of runRoasterLink. */
export interface RoasterLinkDeps {
  db: RoasterLinkDb;
  /** Jev single-choice call; null on any failure (mirrors _shared/jev-client). */
  jevChoose: (
    state: Json,
    question: JevChoiceQuestion,
    opts?: JevAskOptions,
  ) => Promise<JevChoiceAnswer | null>;
}

export interface RoasterLinkOptions {
  mode: RoasterLinkMode;
  correlationId?: string;
  /**
   * Overall wall-clock budget in ms, overriding the per-mode default
   * (800ms in enforce, unbounded in shadow). Test hook: a deadline of 0
   * deterministically exhausts the budget before the Jev call.
   */
  deadlineMs?: number;
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Mirror the DB's public.maintain_normalized_names(), which stores
 * `lower(unaccent(roaster_name))`: Unicode NFD, strip the combining-mark
 * range (what unaccent removes for Latin text), lowercase, trim. Mechanical
 * Unicode normalization only — no semantic judgement about the text.
 */
export function normalizeForSearch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Union candidate lists by roaster_id, keeping each id's highest confidence,
 * sorted descending, capped at `cap` (default 40 — see the measured-facts
 * note). Malformed rows are dropped rather than trusted.
 */
export function mergeCandidates(
  lists: Array<CandidateRow[] | null | undefined>,
  cap: number = MAX_CANDIDATES,
): CandidateRow[] {
  const byId = new Map<number, CandidateRow>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      const roasterId = toFiniteNumber(row?.roasterId);
      const confidence = toFiniteNumber(row?.confidence);
      if (roasterId === null || confidence === null) continue;
      const roasterName = typeof row.roasterName === "string"
        ? row.roasterName
        : "";
      const existing = byId.get(roasterId);
      if (!existing || confidence > existing.confidence) {
        byId.set(roasterId, { roasterId, roasterName, confidence });
      }
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, Math.max(cap, 0));
}

/**
 * One option description: "<name> — <city>, <country>. Also known as:
 * <aliases>." Absent parts are omitted cleanly (a roaster without location or
 * aliases is just "<name>.").
 */
function describeRoasterOption(
  name: string,
  city: string | null,
  country: string | null,
  aliases: string | null,
): string {
  const location = [city, country]
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join(", ");
  let description = location.length > 0 ? `${name} — ${location}.` : `${name}.`;
  if (typeof aliases === "string" && aliases.trim().length > 0) {
    description += ` Also known as: ${aliases.trim()}.`;
  }
  return description;
}

/**
 * Build the Jev choice question: one option per candidate keyed by
 * String(roaster_id), described from the coffee_roasters metadata, plus the
 * reserved __none__ option via withNoneOfTheAbove.
 */
export function buildCriteria(
  candidates: CandidateRow[],
  metaById: Map<number, RoasterMeta>,
): JevChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (const candidate of candidates) {
    const meta = metaById.get(candidate.roasterId);
    criteria[String(candidate.roasterId)] = describeRoasterOption(
      meta?.roasterName ?? candidate.roasterName,
      meta?.city ?? null,
      meta?.country ?? null,
      meta?.aliases ?? null,
    );
  }
  const question: JevChoiceQuestion = {
    type: "choice",
    instructions: ROASTER_LINK_JEV_INSTRUCTIONS,
    criteria,
  };
  return withNoneOfTheAbove(question, {
    noneDescription: ROASTER_LINK_NONE_DESCRIPTION,
  });
}

/** Bag fields that may be sent to Jev. Everything else stays local. */
const JEV_STATE_FIELDS = [
  "roaster",
  "roasterBrandName",
  "name",
  "origin",
  "region",
  "variety",
  "tastingNotes",
] as const;

/**
 * The Jev state: only the parsed bag fields listed in JEV_STATE_FIELDS, with
 * null/empty values omitted. This object goes to a third party (TypeSafe), so
 * userId, locale, images and OCR text must never be added.
 */
export function buildJevState(
  result: Record<string, unknown>,
): Record<string, string> {
  const state: Record<string, string> = {};
  for (const field of JEV_STATE_FIELDS) {
    const value = result[field];
    if (typeof value === "string" && value.trim().length > 0) {
      state[field] = value;
    }
  }
  return state;
}

/**
 * Threshold the Jev answer. Returns { roasterId, p } only when the choice is a
 * roaster id (a positive integer key, never __none__) and
 * probabilities[choice] >= threshold (default 0.9). __none__ is never a link
 * regardless of its probability: link and __none__ decisions are calibrated
 * in opposite directions, so the threshold applies to the chosen option only.
 */
export function decideLink(
  answer: JevChoiceAnswer | null,
  threshold: number = DEFAULT_LINK_THRESHOLD,
): { roasterId: number; p: number } | null {
  if (!answer || answer.choice === JEV_NONE_OPTION_KEY) return null;
  const roasterId = Number(answer.choice);
  if (!Number.isInteger(roasterId) || roasterId <= 0) return null;
  const p = answer.probabilities[answer.choice];
  if (typeof p !== "number" || !Number.isFinite(p) || p < threshold) {
    return null;
  }
  return { roasterId, p };
}

/**
 * Resolve the mode from feature_flags rows. jev_roaster_link enabled wins
 * ("enforce", which also logs), else jev_roaster_link_shadow enabled ->
 * "shadow", else "off". Unknown rows are ignored.
 */
export function resolveMode(
  rows: Array<RoasterLinkFlagRow | null | undefined>,
): RoasterLinkMode {
  const byKey = new Map<string, boolean>();
  for (const row of rows) {
    if (row && typeof row.key === "string") {
      byKey.set(row.key, row.enabled === true);
    }
  }
  if (byKey.get(ROASTER_LINK_FLAG_ENFORCE) === true) return "enforce";
  if (byKey.get(ROASTER_LINK_FLAG_SHADOW) === true) return "shadow";
  return "off";
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// ---------------------------------------------------------------------------
// DB access (thin wrappers over the injected client)
// ---------------------------------------------------------------------------

/** Narrow the RPC rows into CandidateRow[], dropping malformed entries. */
function toCandidateRows(data: unknown): CandidateRow[] {
  if (!Array.isArray(data)) return [];
  const rows: CandidateRow[] = [];
  for (const item of data) {
    if (!isRecord(item)) continue;
    const roasterId = toFiniteNumber(item.roaster_id);
    const confidence = toFiniteNumber(item.confidence);
    const roasterName = asStringOrNull(item.roaster_name);
    if (roasterId === null || confidence === null || roasterName === null) {
      continue;
    }
    rows.push({ roasterId, roasterName, confidence });
  }
  return rows;
}

/**
 * One trigram retrieval call. Trigram only by measured decision: no
 * vector/embedding arm (never evaluated, and it would add an OpenAI embedding
 * call to every scan). Returns null when the RPC reports an error.
 */
async function retrieveCandidates(
  db: RoasterLinkDb,
  search: { searchNormalized: string; displayName: string },
): Promise<CandidateRow[] | null> {
  const { data, error } = await db.rpc("find_potential_roaster_matches", {
    search_normalized_name: search.searchNormalized,
    search_display_name: search.displayName,
    max_results: MAX_CANDIDATES,
    min_confidence: MIN_CANDIDATE_CONFIDENCE,
    search_website_url: null,
  });
  if (error) {
    logError(
      "roaster_link: candidate retrieval failed",
      undefined,
      ErrorCategory.DATABASE,
      ErrorSeverity.LOW,
      { reason: error.message },
    );
    return null;
  }
  return toCandidateRows(data);
}

/**
 * Fetch city/country/aliases for the candidate ids in ONE select. Failure
 * degrades to name-only criteria (candidate rows always carry the catalog
 * name), never an abort of the whole pipeline.
 */
async function fetchMetaById(
  db: RoasterLinkDb,
  ids: number[],
): Promise<Map<number, RoasterMeta>> {
  const metaById = new Map<number, RoasterMeta>();
  if (ids.length === 0) return metaById;
  try {
    const { data, error } = await db
      .from("coffee_roasters")
      .select("id, roaster_name, city, country, aliases")
      .in("id", ids);
    if (error) {
      logError(
        "roaster_link: metadata fetch failed",
        undefined,
        ErrorCategory.DATABASE,
        ErrorSeverity.LOW,
        { reason: error.message },
      );
      return metaById;
    }
    if (Array.isArray(data)) {
      for (const item of data) {
        if (!isRecord(item)) continue;
        const id = toFiniteNumber(item.id);
        if (id === null) continue;
        metaById.set(id, {
          roasterName: asStringOrNull(item.roaster_name),
          city: asStringOrNull(item.city),
          country: asStringOrNull(item.country),
          aliases: asStringOrNull(item.aliases),
        });
      }
    }
  } catch (error) {
    logWarning(
      "roaster_link: metadata fetch threw; continuing with name-only criteria",
      { error: error instanceof Error ? error.message : String(error) },
    );
  }
  return metaById;
}

/**
 * Insert one eval row. Never throws: a failed insert is logged and reported
 * as false so the pipeline's outcome is unaffected.
 */
async function writeEvalRow(
  db: RoasterLinkDb,
  row: JevEvalRoasterLinkRow,
): Promise<boolean> {
  try {
    const { error } = await db.schema("service")
      .from("jev_eval_roaster_link")
      .insert(row as unknown as Record<string, unknown>);
    if (error) {
      logError(
        "roaster_link: eval row insert failed",
        undefined,
        ErrorCategory.DATABASE,
        ErrorSeverity.LOW,
        { reason: error.message, outcome: row.outcome },
      );
      return false;
    }
    return true;
  } catch (error) {
    logError(
      "roaster_link: eval row insert threw",
      error instanceof Error ? error : undefined,
      ErrorCategory.DATABASE,
      ErrorSeverity.LOW,
      { outcome: row.outcome },
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the roaster-link decision for one parsed label.
 *
 * Always resolves (never throws) and returns a RoasterLink only when
 * mode === "enforce" AND a link was decided with p >= 0.9. Shadow mode always
 * resolves to null; it only logs and writes the eval row. Exactly one eval
 * row is attempted per invocation that gets past the skip checks, whatever
 * the outcome, so fallbacks are measurable.
 */
export async function runRoasterLink(
  deps: RoasterLinkDeps,
  result: unknown,
  options: RoasterLinkOptions,
): Promise<RoasterLink | null> {
  const { mode, correlationId } = options;
  if (mode !== "shadow" && mode !== "enforce") return null;

  // Skip checks: pure field inspection, cannot throw. No DB, no network.
  if (!isRecord(result) || typeof result.error === "string") return null;
  const rawRoaster = result.roaster;
  if (typeof rawRoaster !== "string" || rawRoaster.trim().length === 0) {
    return null;
  }
  const brandName = typeof result.roasterBrandName === "string" &&
      result.roasterBrandName.trim().length > 0
    ? result.roasterBrandName
    : null;

  const startedAt = Date.now();
  const deadline = startedAt +
    (options.deadlineMs ??
      (mode === "enforce"
        ? ENFORCE_TOTAL_DEADLINE_MS
        : Number.POSITIVE_INFINITY));
  let evalRowAttempted = false;

  try {
    // --- Retrieval: raw roaster, plus brand name when it differs. ---
    const searches: Array<{ displayName: string; searchNormalized: string }> = [
      {
        displayName: rawRoaster,
        searchNormalized: normalizeForSearch(rawRoaster),
      },
    ];
    if (
      brandName &&
      normalizeForSearch(brandName) !== searches[0].searchNormalized
    ) {
      searches.push({
        displayName: brandName,
        searchNormalized: normalizeForSearch(brandName),
      });
    }

    let retrievalFailed = false;
    const lists: CandidateRow[][] = [];
    for (const search of searches) {
      try {
        const rows = await retrieveCandidates(deps.db, search);
        if (rows === null) {
          retrievalFailed = true;
          continue;
        }
        lists.push(rows);
      } catch (error) {
        retrievalFailed = true;
        logError(
          "roaster_link: candidate retrieval threw",
          error instanceof Error ? error : undefined,
          ErrorCategory.DATABASE,
          ErrorSeverity.LOW,
        );
      }
    }

    const candidates = mergeCandidates(lists, MAX_CANDIDATES);
    const latencyMs = () => Date.now() - startedAt;

    if (candidates.length === 0) {
      // Zero candidates: skip Jev entirely but still record the outcome.
      const outcome: RoasterLinkEvalOutcome = retrievalFailed
        ? "error"
        : "no_candidates";
      logInfo(
        `roaster_link: ${outcome}`,
        { marker: "roaster_link", outcome, correlation_id: correlationId },
        correlationId,
      );
      evalRowAttempted = true;
      await writeEvalRow(deps.db, {
        correlation_id: correlationId ?? null,
        mode,
        outcome,
        raw_roaster: rawRoaster,
        roaster_brand_name: brandName,
        jev_state: null, // Jev never ran
        candidate_ids: [],
        trigram_top_id: null,
        trigram_top_conf: null,
        jev_choice: null,
        jev_p: null,
        jev_confidence: null,
        jev_probabilities: null,
        linked_roaster_id: null,
        latency_ms: latencyMs(),
        true_roaster_id: null,
        labelled_at: null,
      });
      return null;
    }

    // --- Metadata, criteria, state, Jev. ---
    const metaById = await fetchMetaById(
      deps.db,
      candidates.map((c) => c.roasterId),
    );
    const state = buildJevState(result);
    const question = buildCriteria(candidates, metaById);

    const remainingMs = deadline - Date.now();
    let answer: JevChoiceAnswer | null = null;
    if (remainingMs <= 0) {
      logWarning(
        "roaster_link: enforce deadline exceeded before the Jev call",
        {
          marker: "roaster_link",
          elapsed_ms: latencyMs(),
          correlation_id: correlationId,
        },
      );
    } else {
      // Shadow may take its time (nobody waits); enforce caps the Jev call at
      // the remaining budget so retrieval + metadata + Jev fits the deadline.
      const timeoutMs = mode === "shadow" ? SHADOW_JEV_TIMEOUT_MS : remainingMs;
      answer = await deps.jevChoose(state, question, {
        timeoutMs,
        correlationId,
      });
    }

    // --- Decide + record. One eval row whatever happened. ---
    const decision = decideLink(answer);
    const outcome: RoasterLinkEvalOutcome = answer === null
      ? "jev_failed"
      : decision
      ? "linked"
      : answer.choice === JEV_NONE_OPTION_KEY
      ? "abstained"
      : "below_threshold";

    logInfo(
      `roaster_link: ${outcome}`,
      {
        marker: "roaster_link",
        outcome,
        mode,
        choice: answer?.choice ?? null,
        p: answer ? answer.probabilities[answer.choice] ?? null : null,
        n_candidates: candidates.length,
        latency_ms: latencyMs(),
        correlation_id: correlationId,
      },
      correlationId,
    );

    evalRowAttempted = true;
    await writeEvalRow(deps.db, {
      correlation_id: correlationId ?? null,
      mode,
      outcome,
      raw_roaster: rawRoaster,
      roaster_brand_name: brandName,
      jev_state: answer === null ? null : state,
      candidate_ids: candidates.map((c) => c.roasterId),
      trigram_top_id: candidates[0].roasterId,
      trigram_top_conf: candidates[0].confidence,
      jev_choice: answer?.choice ?? null,
      jev_p: answer ? answer.probabilities[answer.choice] ?? null : null,
      jev_confidence: answer?.confidence ?? null,
      jev_probabilities: answer?.probabilities ?? null,
      linked_roaster_id: decision?.roasterId ?? null,
      latency_ms: latencyMs(),
      true_roaster_id: null,
      labelled_at: null,
    });

    if (decision && mode === "enforce") {
      const canonicalName = metaById.get(decision.roasterId)?.roasterName ??
        candidates.find((c) => c.roasterId === decision.roasterId)
          ?.roasterName ??
        rawRoaster;
      return {
        roasterId: decision.roasterId,
        canonicalName,
        p: decision.p,
        raw: rawRoaster,
      };
    }
    // Shadow mode never changes the response, whatever was decided.
    return null;
  } catch (error) {
    logError(
      "roaster_link: unexpected failure",
      error instanceof Error ? error : undefined,
      ErrorCategory.EXTERNAL_API,
      ErrorSeverity.LOW,
      { correlation_id: correlationId },
      correlationId,
    );
    if (!evalRowAttempted) {
      await writeEvalRow(deps.db, {
        correlation_id: correlationId ?? null,
        mode,
        outcome: "error",
        raw_roaster: rawRoaster,
        roaster_brand_name: brandName,
        jev_state: null,
        candidate_ids: null,
        trigram_top_id: null,
        trigram_top_conf: null,
        jev_choice: null,
        jev_p: null,
        jev_confidence: null,
        jev_probabilities: null,
        linked_roaster_id: null,
        latency_ms: Date.now() - startedAt,
        true_roaster_id: null,
        labelled_at: null,
      });
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Wiring helpers for index.ts
// ---------------------------------------------------------------------------

/** Default deps: the real Jev client over the injected Supabase client. */
export function makeRoasterLinkDeps(supabase: RoasterLinkDb): RoasterLinkDeps {
  return { db: supabase, jevChoose: realJevChoose };
}

/**
 * Read the two feature flags and resolve the mode. Any failure (error, odd
 * shape, missing table) resolves to "off" — the feature must fail closed.
 */
export async function readRoasterLinkMode(
  db: RoasterLinkDb,
): Promise<RoasterLinkMode> {
  try {
    const { data, error } = await db.schema("service")
      .from("feature_flags")
      .select("key, enabled")
      .in("key", [ROASTER_LINK_FLAG_SHADOW, ROASTER_LINK_FLAG_ENFORCE]);
    if (error) {
      logError(
        "roaster_link: feature flag read failed",
        undefined,
        ErrorCategory.DATABASE,
        ErrorSeverity.LOW,
        { reason: error.message },
      );
      return "off";
    }
    const rows = Array.isArray(data) ? data : [];
    return resolveMode(
      rows.map((row) => ({
        key: typeof row?.key === "string" ? row.key : "",
        enabled: row?.enabled === true,
      })),
    );
  } catch (error) {
    logError(
      "roaster_link: feature flag read threw",
      error instanceof Error ? error : undefined,
      ErrorCategory.DATABASE,
      ErrorSeverity.LOW,
    );
    return "off";
  }
}
