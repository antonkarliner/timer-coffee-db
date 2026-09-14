// instagram-routing
// ────────────────────────────────────────────────────────────────
// Deterministic post-model routing of the proposed roaster_website_url /
// instagram_url pair (plan 030, step 3). Runs after every model stage so an
// Instagram account URL produced by the model never survives in the website
// field: it is moved to instagram_url when the destination is empty or names
// the identical account (exactly what routeRoasterUrls does when it reports
// no conflict), and escalated as a conflict to the caller otherwise.
//
// Pure module: no I/O, no environment access, never throws.
// ────────────────────────────────────────────────────────────────
import {
  type RoasterUrlConflict,
  routeRoasterUrls,
} from "../_shared/roaster-url.ts";

/** Persisted shape of one stage's routing decision (kept in stage_data/signals). */
export interface InstagramRoutingRecord {
  routed: boolean;
  conflict: RoasterUrlConflict | null;
  notes: string[];
}

export interface InstagramRoutingOutcome {
  /** A COPY of the proposed record, with roaster_website_url and instagram_url settled. */
  proposed: Record<string, unknown>;
  routed: boolean;
  conflict: RoasterUrlConflict | null;
  notes: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

/**
 * Routes proposed.roaster_website_url / proposed.instagram_url through the
 * shared classifier. On conflict, roaster_website_url is nulled (an Instagram
 * URL must never survive in the website field) and instagram_url keeps
 * routing.instagram_url; the caller escalates to human review. Never mutates
 * the input object; every other key is preserved untouched. Never throws.
 */
export function applyInstagramRouting(
  proposed: Record<string, unknown> | null | undefined,
): InstagramRoutingOutcome {
  const copy = { ...asRecord(proposed) };
  const routing = routeRoasterUrls(
    copy.roaster_website_url,
    copy.instagram_url,
  );
  if (routing.conflict) {
    copy.roaster_website_url = null;
    copy.instagram_url = routing.instagram_url;
  } else {
    copy.roaster_website_url = routing.website_url;
    copy.instagram_url = routing.instagram_url;
  }
  return {
    proposed: copy,
    routed: routing.routed,
    conflict: routing.conflict,
    notes: routing.notes,
  };
}

/**
 * Merges the routing records of consecutive pipeline stages: `routed` is true
 * when any stage routed, the first conflict wins, and notes are unioned in
 * order without duplicates.
 */
export function mergeInstagramRoutingRecords(
  records: Array<InstagramRoutingRecord | null | undefined>,
): InstagramRoutingRecord {
  let routed = false;
  let conflict: RoasterUrlConflict | null = null;
  const notes: string[] = [];
  for (const record of records) {
    if (!record) continue;
    if (record.routed) routed = true;
    if (conflict === null && record.conflict) conflict = record.conflict;
    for (const note of Array.isArray(record.notes) ? record.notes : []) {
      if (!notes.includes(note)) notes.push(note);
    }
  }
  return { routed, conflict, notes };
}
