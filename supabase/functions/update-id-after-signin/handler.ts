import {
  type Caller,
  decideBeforeOldUserLookup,
  hasSourceProof,
  isCanonicalUuid,
  isMissingOldUserError,
} from "./decide.ts";

type Result<T> = { data: T; error: unknown };
type SourceUser = { id: string; is_anonymous?: boolean };
export type Migration = {
  status: "data_migrated" | "completed";
  already: boolean;
  moved: Record<string, number>;
};
export type UpdateIdAfterSigninDeps = {
  resolveCaller(req: Request): Promise<
    | { ok: true; user: Caller }
    | { ok: false; status: 401; error: string }
  >;
  getSourceUser(token: string): Promise<Result<SourceUser | null>>;
  getLedger(source: string, destination: string): Promise<
    Result<{ status: "data_migrated" | "completed" } | null>
  >;
  getOldUser(source: string): Promise<Result<SourceUser | null>>;
  migrate(
    source: string,
    destination: string,
  ): Promise<Result<Migration | null>>;
  deleteUser(source: string): Promise<{ error: unknown }>;
  complete(
    source: string,
    destination: string,
  ): Promise<Result<boolean | null>>;
  getCorsHeaders(origin?: string): Record<string, string>;
  logInfo(message: string, details?: Record<string, unknown>): void;
  logWarning(message: string, details?: Record<string, unknown>): void;
  logError(message: string): void;
};

export function createUpdateIdAfterSigninHandler(
  deps: UpdateIdAfterSigninDeps,
) {
  return async function handleRequest(req: Request): Promise<Response> {
    const cors = deps.getCorsHeaders(req.headers.get("origin") ?? undefined);
    const json = (body: Record<string, unknown>, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: cors });
    }
    try {
      const caller = await deps.resolveCaller(req);
      if (!caller.ok) return json({ error: caller.error }, caller.status);
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      const { oldUserId, newUserId, oldAccessToken } = body ?? {};
      if (!oldUserId || !newUserId) {
        return json(
          { error: "Both oldUserId and newUserId are required" },
          400,
        );
      }
      const initial = decideBeforeOldUserLookup(
        caller.user,
        oldUserId,
        newUserId,
      );
      if (initial.kind === "reject") {
        deps.logWarning("Rejected user ID migration", {
          callerId: caller.user.id,
        });
        return json({ error: initial.error }, initial.status);
      }
      if (initial.kind === "skip") return json({ skipped: initial.reason });
      if (!isCanonicalUuid(oldUserId)) {
        return json({ error: "oldUserId must be a UUID" }, 400);
      }
      if (!hasSourceProof(oldAccessToken)) {
        deps.logWarning("Source proof required for user ID migration", {
          callerId: caller.user.id,
        });
        return json({
          skipped: "source_proof_required",
          upgradeRequired: true,
        });
      }
      const invalidProof = () =>
        json({
          error: "Invalid or expired source session",
          code: "invalid_source_proof",
        }, 403);
      // Auth lookup failures cannot authorize migration; only the ledger may prove a retry.
      const proof = await deps.getSourceUser(oldAccessToken).catch(() => ({
        data: null,
        error: true,
      }));
      if (proof.error || !proof.data) {
        const ledger = await deps.getLedger(oldUserId, caller.user.id);
        if (ledger.error) {
          deps.logError("Failed to look up anonymous migration ledger");
          return json({ error: "Failed to look up migration state" }, 500);
        }
        if (ledger.data?.status === "completed") {
          return json({ skipped: "already_migrated" });
        }
        if (ledger.data?.status === "data_migrated") {
          const oldUser = await deps.getOldUser(oldUserId);
          if (oldUser.error && !isMissingOldUserError(oldUser.error)) {
            return json({ error: "Failed to look up old user" }, 500);
          }
          if (isMissingOldUserError(oldUser.error) || !oldUser.data) {
            const completed = await deps.complete(oldUserId, caller.user.id);
            if (completed.error || completed.data !== true) {
              return json({ error: "Failed to complete migration" }, 500);
            }
            return json({ skipped: "already_migrated" });
          }
        }
        return invalidProof();
      }
      if (proof.data.id !== oldUserId) {
        return json({
          error: "Source session does not match oldUserId",
          code: "source_proof_mismatch",
        }, 403);
      }
      if (proof.data.is_anonymous !== true) {
        return json({ skipped: "old_user_not_anonymous" });
      }
      const source = proof.data.id;
      const destination = caller.user.id;
      const migration = await deps.migrate(source, destination);
      if (migration.error || !migration.data) {
        const error = migration.error as
          | { code?: string; message?: string }
          | null;
        if (
          error?.code === "PT409" ||
          error?.message === "anonymous_migration_conflict"
        ) {
          return json({
            error: "Source account was already migrated to a different account",
            code: "source_already_claimed",
          }, 409);
        }
        deps.logError("Failed to migrate user data");
        return json({ error: "Failed to migrate user data" }, 500);
      }
      const deletion = await deps.deleteUser(source).catch(() => ({
        error: true,
      }));
      if (deletion.error && !isMissingOldUserError(deletion.error)) {
        deps.logError("Failed to delete source user");
        return json({
          error: "Failed to delete source user",
          code: "source_delete_failed",
        }, 500);
      }
      try {
        const completed = await deps.complete(source, destination);
        if (completed.error || completed.data !== true) {
          deps.logError("Failed to complete anonymous migration ledger");
        }
      } catch {
        deps.logError("Failed to complete anonymous migration ledger");
      }
      deps.logInfo("User ID migration completed", { callerId: destination });
      return json({
        message: "User ID updated and old user deleted successfully",
        moved: migration.data.moved,
        fcmTokensUpdated: migration.data.moved.fcm_tokens,
        oldUserDeleted: true,
      });
    } catch {
      deps.logError("User ID migration failed");
      return json({ error: "Failed to migrate user data" }, 500);
    }
  };
}
