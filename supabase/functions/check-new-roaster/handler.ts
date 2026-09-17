import {
  buildCandidateInsert,
  CandidateInsertPayload,
  decideCandidateCapture,
} from "./candidate-policy.ts";

export interface CandidateHandlerDependencies {
  insertCandidate(payload: CandidateInsertPayload): Promise<void>;
  notifyCandidate?(payload: CandidateInsertPayload): Promise<void>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleCandidateWebhook(
  request: Request,
  dependencies: CandidateHandlerDependencies,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "Invalid JSON" }, 400);
  }
  if (typeof body !== "object" || body === null) {
    return json({ success: false, error: "Invalid request" }, 400);
  }
  const webhook = body as Record<string, unknown>;
  const record = webhook.record;
  if (
    webhook.type !== "INSERT" || typeof record !== "object" ||
    record === null ||
    typeof (record as Record<string, unknown>).roaster !== "string" ||
    !(record as Record<string, unknown>).roaster?.toString().trim()
  ) {
    return json({ success: false, error: "Invalid request" }, 400);
  }
  const sourceRecord = record as Record<string, unknown>;
  const decision = decideCandidateCapture(sourceRecord);
  if (decision.kind === "already_linked") {
    return json({
      success: true,
      captured: false,
      reason: "already_linked",
      coffee_roaster_id: decision.coffee_roaster_id,
    });
  }
  const candidate = buildCandidateInsert(sourceRecord);
  await dependencies.insertCandidate(candidate);
  if (dependencies.notifyCandidate) {
    try {
      await dependencies.notifyCandidate(candidate);
    } catch (error) {
      console.warn("Optional candidate notification failed", error);
    }
  }
  return json({
    success: true,
    captured: true,
    reason: "unreviewed_candidate",
  });
}
