/** Recipient permissions are checked separately from request-shape validation. */
export function canManageScheduledRecipient(
  isAdmin: boolean,
  callerId: string,
  fields: {
    audience?: "user" | "broadcast";
    user_id?: string | null;
    target_user_ids?: string[] | null;
  },
): boolean {
  return isAdmin ||
    (fields.audience !== "broadcast" && fields.target_user_ids === undefined &&
      (fields.user_id === undefined || fields.user_id === callerId));
}
/** Keep user jobs, but release every broadcast after the first before dispatch. */
export function partitionScheduledJobs<
  T extends { id: string; audience?: string },
>(jobs: T[]): { processJobs: T[]; deferredIds: string[] } {
  let broadcastTaken = false;
  const processJobs: T[] = [];
  const deferredIds: string[] = [];
  for (const job of jobs) {
    if (job.audience === "broadcast") {
      if (broadcastTaken) {
        deferredIds.push(job.id);
        continue;
      }
      broadcastTaken = true;
    }
    processJobs.push(job);
  }
  return { processJobs, deferredIds };
}
