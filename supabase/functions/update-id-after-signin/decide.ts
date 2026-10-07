export interface Caller {
  id: string;
  isAnonymous: boolean;
}

export type InitialDecision =
  | { kind: "reject"; status: 403; error: string }
  | { kind: "skip"; reason: "same_user" }
  | { kind: "lookup_old_user" };

export type OldUserLookup =
  | { found: false }
  | { found: true; isAnonymous: boolean };

export type FinalDecision =
  | { kind: "skip"; reason: "old_user_missing" }
  | { kind: "skip"; reason: "old_user_not_anonymous" }
  | { kind: "migrate"; oldUserId: string; newUserId: string };

export function decideBeforeOldUserLookup(
  caller: Caller,
  oldUserId: string,
  newUserId: string,
): InitialDecision {
  if (caller.isAnonymous) {
    return {
      kind: "reject",
      status: 403,
      error: "Anonymous callers cannot migrate user data",
    };
  }
  if (newUserId !== caller.id) {
    return {
      kind: "reject",
      status: 403,
      error: "newUserId must match the authenticated user",
    };
  }
  if (oldUserId === caller.id) {
    return { kind: "skip", reason: "same_user" };
  }
  return { kind: "lookup_old_user" };
}

export function decideAfterOldUserLookup(
  caller: Caller,
  oldUserId: string,
  oldUser: OldUserLookup,
): FinalDecision {
  if (!oldUser.found) {
    return { kind: "skip", reason: "old_user_missing" };
  }
  if (!oldUser.isAnonymous) {
    return { kind: "skip", reason: "old_user_not_anonymous" };
  }
  return { kind: "migrate", oldUserId, newUserId: caller.id };
}

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    );
}

export function hasSourceProof(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// Only a definite "no such user" counts as missing. A 400 is not: treating it
// as missing would let the ledger mark a migration completed while the source
// Auth user still exists.
export function isMissingOldUserError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    status?: number;
    code?: string;
    message?: string;
  };
  return candidate.status === 404 ||
    candidate.code === "user_not_found" ||
    candidate.message?.toLowerCase().includes("not found") === true;
}
