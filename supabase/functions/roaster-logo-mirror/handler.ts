// Legacy HTTP webhooks are retired; roaster-postprocess-worker processes canonical rows.
export function handler(req: Request, cors: Record<string, string>): Response {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: cors });
  }
  return new Response(
    JSON.stringify({
      error:
        "This endpoint is retired. Logo mirroring and dominant-colour extraction run in roaster-postprocess-worker.",
    }),
    {
      status: 410,
      headers: { ...cors, "Content-Type": "application/json" },
    },
  );
}
