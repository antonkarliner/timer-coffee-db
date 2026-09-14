export const EVIDENCE_POLICY_VERSION = 2;
export const REVIEW_CONFIDENCE_THRESHOLD = 0.8;

function safeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseNotes(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export function buildPolicyV2Context(options: {
  candidates: Record<string, unknown>[];
  userContribution?: Record<string, unknown> | null;
}): {
  candidate_context: Record<string, unknown>;
  legacy_upstream_telemetry: Record<string, number>;
} {
  const candidates = options.candidates.slice(0, 8).map((candidate) => {
    const notes = parseNotes(candidate.notes);
    return {
      id: candidate.id ?? null,
      roaster: typeof candidate.roaster === "string" ? candidate.roaster : null,
      coffee_bean_name: typeof candidate.coffee_bean_name === "string"
        ? candidate.coffee_bean_name
        : null,
      source_record: notes?.source_record ?? null,
    };
  });
  const user = options.userContribution;
  const userContribution = user
    ? {
      website_url: user.website_url ?? null,
      instagram_url: user.instagram_url ?? null,
      city: user.city ?? null,
      country: user.country ?? null,
    }
    : null;
  return {
    candidate_context: {
      candidates,
      user_contribution: userContribution,
      search_evidence: { source: "worker_cluster_search_v2", results: [] },
    },
    legacy_upstream_telemetry: {
      candidate_count: options.candidates.length,
      rows_with_location:
        options.candidates.filter((candidate) => candidate.location != null)
          .length,
      rows_with_stored_search_results:
        options.candidates.filter((candidate) =>
          safeArray(candidate.google_search_results).length > 0 ||
          safeArray(candidate.bean_search_results).length > 0
        ).length,
    },
  };
}

export function validationReasons(options: {
  extraction: Record<string, any>;
  reenrichment?: unknown;
}): string[] {
  const proposed = options.extraction.proposed ?? {};
  const reasons: string[] = [];
  // Plan 030: a roaster with only an Instagram profile is legitimate, so the
  // identity requirement is a website OR an Instagram URL, not a website.
  if (
    !proposed.roaster_name || !proposed.country ||
    (!proposed.roaster_website_url && !proposed.instagram_url)
  ) reasons.push("missing_required_fields");
  if (safeArray(options.extraction.conflicts).length > 0) {
    reasons.push("conflicts");
  }
  if ((options.extraction.confidence ?? 0) < REVIEW_CONFIDENCE_THRESHOLD) {
    reasons.push("low_confidence");
  }
  if (options.reenrichment) reasons.push("reenrichment_context");
  if (proposed.city || proposed.state || proposed.country || proposed.address) {
    reasons.push("proposed_location");
  }
  return reasons;
}

export function finalDisposition(options: {
  confidence: number | null | undefined;
  validatorNeedsReview?: boolean;
  unresolvedConflicts?: unknown[];
}): "completed" | "needs_review" {
  if (options.validatorNeedsReview) return "needs_review";
  if ((options.confidence ?? 0) < REVIEW_CONFIDENCE_THRESHOLD) {
    return "needs_review";
  }
  if (safeArray(options.unresolvedConflicts).length > 0) return "needs_review";
  return "completed";
}

export function shouldRestartForPolicyV2(job: Record<string, any>): boolean {
  return (job.state === "queued" || job.state === "running") &&
    job.stage !== "triage" && job.stage !== "done" &&
    job.stage_data?.evidence_policy_version !== EVIDENCE_POLICY_VERSION &&
    job.stage_data?.policy_v2_restart_applied !== true;
}
