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
