import { assertEquals } from "https://deno.land/std@0.223.0/assert/mod.ts";
import type {
  CallerDeps,
  LabelParseOutcome,
  QuotaDeps,
} from "../_shared/label-parse-quota.ts";
import {
  beginLabelParseRequest,
  runReservedLabelParse,
} from "./request-flow.ts";

const getUser: CallerDeps["getUser"] = () =>
  Promise.resolve(
    {
      data: { user: { id: "caller", is_anonymous: true } },
      error: null,
    } as Awaited<ReturnType<CallerDeps["getUser"]>>,
  );
function deps(
  overrides: Partial<QuotaDeps & CallerDeps> = {},
): QuotaDeps & CallerDeps {
  return {
    getUser,
    isProUser: () => Promise.resolve(false),
    reserve: () =>
      Promise.resolve({ admitted: true, reservation_id: 1, used: 0 }),
    finalize: () => Promise.resolve(true),
    log: () => {},
    ...overrides,
  };
}
function request(body: unknown = { imagesBase64: ["image"] }, auth = true) {
  return new Request("https://local", {
    method: "POST",
    headers: auth ? { Authorization: "Bearer guest" } : {},
    body: JSON.stringify(body),
  });
}
async function handle(
  req: Request,
  dependencies: ReturnType<typeof deps>,
  run: (dispatch: () => void) => Promise<Response>,
) {
  const prepared = await beginLabelParseRequest(
    req,
    dependencies,
    "primary",
    {},
  );
  if (prepared.response) return prepared.response;
  const context = prepared.context!;
  return runReservedLabelParse(
    context,
    dependencies,
    () =>
      run(() => {
        context.dispatched = true;
      }),
    (error) =>
      new Response(JSON.stringify({ error: (error as Error).message })),
  );
}
Deno.test("request frontend denies before providers with exact contracts", async () => {
  let providers = 0;
  const run = () => {
    providers++;
    return Promise.resolve(new Response("{}"));
  };
  for (
    const [req, dependency, status, body] of [
      [
        request({}, false),
        deps({
          getUser: () => {
            throw new Error("must not lookup");
          },
        }),
        401,
        {
          error: "Unauthorized",
          message: "A signed-in or guest session is required.",
        },
      ],
      [request({ imagesBase64: ["image"], userId: "other" }), deps(), 403, {
        error: "Forbidden",
        message: "userId does not match the authenticated user.",
      }],
      [
        request(),
        deps({
          reserve: () =>
            Promise.resolve({
              admitted: false,
              reservation_id: null,
              used: 20,
            }),
        }),
        200,
        {
          error: "Invocation limit reached",
          message:
            "Sorry, you reached your token limit for image recognition this month",
        },
      ],
      [
        request(),
        deps({ reserve: () => Promise.reject(new Error("outage")) }),
        503,
        { error: "Recognition quota is temporarily unavailable" },
      ],
      [
        request(),
        deps({ isProUser: () => Promise.reject(new Error("outage")) }),
        503,
        { error: "Recognition quota is temporarily unavailable" },
      ],
      [
        new Request("https://local", {
          method: "POST",
          headers: { Authorization: "Bearer guest" },
          body: "{",
        }),
        deps(),
        400,
        { error: "Invalid JSON body" },
      ],
      [request({ imagesBase64: [] }), deps(), 400, {
        error: "No images or OCR text provided",
      }],
    ] as const
  ) {
    const response = await handle(req, dependency, run);
    assertEquals(response.status, status);
    assertEquals(await response.json(), body);
  }
  assertEquals(providers, 0);
});
Deno.test("provider lifecycle finalizes success, billed failure and release", async () => {
  for (const outcome of ["succeeded", "failed_billed", "released"] as const) {
    const finalized: LabelParseOutcome[] = [];
    const response = await handle(
      request(),
      deps({
        finalize: (id, value) => {
          assertEquals(id, 1);
          finalized.push(value);
          return Promise.resolve(true);
        },
      }),
      (dispatch) => {
        if (outcome !== "released") dispatch();
        if (outcome !== "succeeded") throw new Error("provider failed");
        return Promise.resolve(
          new Response(JSON.stringify({ name: "coffee" })),
        );
      },
    );
    assertEquals(finalized, [outcome]);
    assertEquals(response.status, 200);
    assertEquals(
      await response.json(),
      outcome === "succeeded"
        ? { name: "coffee" }
        : { error: "provider failed" },
    );
  }
});
Deno.test("11 parallel requests against serialized shared quota admit exactly 10", async () => {
  let used = 0;
  let mutex = Promise.resolve();
  let providers = 0;
  const dependency = deps({
    reserve: (args) => {
      assertEquals(args.p_user_id, "caller");
      const admission = mutex.then(() => {
        const previous = used;
        if (used + args.p_units > 10) {
          return { admitted: false, reservation_id: null, used };
        }
        used += args.p_units;
        return { admitted: true, reservation_id: used, used: previous };
      });
      mutex = admission.then(() => {});
      return admission;
    },
  });
  const responses = await Promise.all(
    Array.from(
      { length: 11 },
      () =>
        handle(request(), dependency, (dispatch) => {
          dispatch();
          providers++;
          return Promise.resolve(new Response("{}"));
        }),
    ),
  );
  const bodies = await Promise.all(
    responses.map((response) => response.json()),
  );
  assertEquals(providers, 10);
  assertEquals(used, 10);
  assertEquals(
    bodies.filter((body) => body.error === "Invocation limit reached").length,
    1,
  );
});

Deno.test("authentication precedes JSON parsing and quota lookup", async () => {
  const req = new Request("https://local", { method: "POST", body: "{" });
  const prepared = await beginLabelParseRequest(
    req,
    deps({
      isProUser: () => {
        throw new Error("must not check quota");
      },
    }),
    "primary",
    {},
  );
  assertEquals(prepared.response?.status, 401);
  assertEquals(req.bodyUsed, false);
});
