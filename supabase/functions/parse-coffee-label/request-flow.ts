import {
  admitLabelParse,
  type CallerDeps,
  finalizeLabelParse,
  labelParseIdentityMismatch,
  type LabelParseRoute,
  type QuotaDeps,
  resolveLabelParseCaller,
  validateLabelParseInput,
} from "../_shared/label-parse-quota.ts";

export async function beginLabelParseRequest(
  req: Request,
  deps: CallerDeps & QuotaDeps,
  route: LabelParseRoute,
  cors: Record<string, string>,
  onLimit?: (
    details: {
      userId: string;
      units: number;
      proUser: boolean;
      tokensUsedThisMonth: number;
      tokenLimit: number;
    },
  ) => void,
) {
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  const caller = await resolveLabelParseCaller(req, deps);
  if (!caller.ok) {
    return {
      response: json(
        { error: caller.error, message: caller.message },
        caller.status,
      ),
    };
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { response: json({ error: "Invalid JSON body" }, 400) };
  }
  const input = validateLabelParseInput(body, route);
  if (!input.ok) return { response: json({ error: input.error }, 400) };
  const userId = caller.user.id;
  if (labelParseIdentityMismatch(userId, input.legacyUserId)) {
    return {
      response: json({
        error: "Forbidden",
        message: "userId does not match the authenticated user.",
      }, 403),
    };
  }
  let admission;
  try {
    admission = await admitLabelParse(deps, {
      userId,
      units: input.units,
      route,
    });
  } catch {
    return {
      response: json(
        { error: "Recognition quota is temporarily unavailable" },
        503,
      ),
    };
  }
  if (!admission.admitted) {
    onLimit?.({
      userId,
      units: input.units,
      proUser: admission.proUser,
      tokensUsedThisMonth: admission.used,
      tokenLimit: admission.limit,
    });
    return {
      response: json({
        error: "Invocation limit reached",
        message:
          "Sorry, you reached your token limit for image recognition this month",
      }, 200),
    };
  }
  return {
    context: { input, userId, admission, dispatched: false },
    response: undefined,
  };
}

export type LabelParseContext = NonNullable<
  Awaited<ReturnType<typeof beginLabelParseRequest>>["context"]
>;

export async function runReservedLabelParse(
  context: LabelParseContext,
  deps: QuotaDeps,
  run: () => Promise<Response>,
  onError: (error: unknown) => Response,
) {
  try {
    const response = await run();
    await finalizeLabelParse(
      deps,
      context.admission.reservationId!,
      "succeeded",
    );
    return response;
  } catch (error) {
    await finalizeLabelParse(
      deps,
      context.admission.reservationId!,
      context.dispatched ? "failed_billed" : "released",
    );
    return onError(error);
  }
}
