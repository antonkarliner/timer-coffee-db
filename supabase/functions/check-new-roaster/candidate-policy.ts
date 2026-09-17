export type CandidateDecision =
  | { kind: "already_linked"; coffee_roaster_id: number }
  | { kind: "capture_candidate" };

export interface CandidateInsertPayload {
  roaster: string;
  coffee_bean_name: string;
  similar_candidates: unknown[];
  google_search_results: unknown[];
  bean_search_results: unknown[];
  location: null;
  notes: string;
}

export function decideCandidateCapture(
  record: Record<string, unknown>,
): CandidateDecision {
  const id = record.coffee_roaster_id;
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) {
    return { kind: "already_linked", coffee_roaster_id: id };
  }
  return { kind: "capture_candidate" };
}

function nullableValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : null;
}

export function buildCandidateInsert(
  record: Record<string, unknown>,
): CandidateInsertPayload {
  const roaster = typeof record.roaster === "string"
    ? record.roaster.trim()
    : "";
  const beanName = typeof record.name === "string" ? record.name.trim() : "";
  return {
    roaster,
    coffee_bean_name: beanName,
    similar_candidates: [],
    google_search_results: [],
    bean_search_results: [],
    location: null,
    notes: JSON.stringify({
      source: "check-new-roaster",
      evidence_policy_version: 2,
      source_record: {
        id: nullableValue(record, "id"),
        origin: nullableValue(record, "origin"),
        region: nullableValue(record, "region"),
        farm: nullableValue(record, "farm"),
        farmer: nullableValue(record, "farmer"),
        variety: nullableValue(record, "variety"),
        processing_method: nullableValue(record, "processing_method"),
        tasting_notes: nullableValue(record, "tasting_notes"),
        cupping_score: nullableValue(record, "cupping_score"),
      },
    }),
  };
}
