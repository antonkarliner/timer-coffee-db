import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.223.0/assert/mod.ts";
import {
  admitLabelParse,
  type CallerDeps,
  finalizeLabelParse,
  type QuotaDeps,
  resolveLabelParseCaller,
  validateLabelParseInput,
} from "./label-parse-quota.ts";

const good = { imagesBase64: ["image"] };
Deno.test("input validation covers malformed bodies, images and OCR", () => {
  for (const body of [null, [], "text", 1, new Date()]) {
    assertEquals(validateLabelParseInput(body, "primary").ok, false);
  }
  for (
    const imagesBase64 of [
      undefined,
      null,
      [],
      "image",
      [1],
      [null],
      [""],
      [" "],
      ["a", "b", "c"],
      ["a".repeat(12_000_001)],
    ]
  ) {
    assertEquals(
      validateLabelParseInput({ imagesBase64 }, "primary").ok,
      false,
    );
  }
  for (const ocrText of [null, 1, {}, "a".repeat(20_001), " "]) {
    assertEquals(validateLabelParseInput({ ocrText }, "primary").ok, false);
  }
  assertEquals(
    validateLabelParseInput({ imagesBase64: ["a", "b", "c"] }, "primary"),
    { ok: false, status: 400, error: "At most 2 images are supported" },
  );
  assertEquals(validateLabelParseInput({}, "primary"), {
    ok: false,
    status: 400,
    error: "No images or OCR text provided",
  });
  for (
    const body of [{ ocrText: "label" }, {
      ...good,
      imagesBase64: [],
      ocrText: "label",
    }, { imagesBase64: null, ocrText: "label" }]
  ) {
    const input = validateLabelParseInput(body, "primary");
    assertEquals(input.ok && input.units, 1);
  }
  for (
    const [body, units] of [[good, 1], [{ imagesBase64: ["a", "b"] }, 2], [{
      imagesBase64: ["a".repeat(12_000_000)],
      ocrText: "x".repeat(20_000),
    }, 1]] as const
  ) {
    const input = validateLabelParseInput(body, "primary");
    assertEquals(input.ok && input.units, units);
  }
  for (const body of [{}, { imagesBase64: [] }, { ocrText: "label" }]) {
    assertEquals(validateLabelParseInput(body, "gemini"), {
      ok: false,
      status: 400,
      error: "No images provided",
    });
  }
  const gemini = validateLabelParseInput(
    { ...good, ocrText: 42, locale: 1 },
    "gemini",
  );
  assertEquals(gemini.ok && gemini.ocrText, null);
  assertEquals(gemini.ok && gemini.locale, undefined);
  const input = validateLabelParseInput({
    ...good,
    locale: "fr",
    userId: "legacy",
  }, "primary");
  assertEquals(input.ok && input.locale, "fr");
  assertEquals(input.ok && input.legacyUserId, "legacy");
});

export const getUser: CallerDeps["getUser"] = (token) =>
  Promise.resolve(
    {
      data: {
        user: token === "anon-key"
          ? null
          : { id: "caller", is_anonymous: token === "guest" },
      },
      error: null,
    } as Awaited<ReturnType<CallerDeps["getUser"]>>,
  );
Deno.test("caller resolution accepts real anonymous/permanent sessions only", async () => {
  for (const token of [undefined, "anon-key", "guest", "permanent"]) {
    const caller = await resolveLabelParseCaller(
      new Request("https://local", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }),
      { getUser },
    );
    assertEquals(caller.ok, token === "guest" || token === "permanent");
    if (caller.ok) assertEquals(caller.user.isAnonymous, token === "guest");
    else assertEquals(caller.status, 401);
  }
  for (const legacyUserId of [undefined, null, "", "caller", "someone-else"]) {
    const caller = await resolveLabelParseCaller(
      new Request("https://local", {
        headers: { Authorization: "Bearer guest" },
      }),
      { getUser, legacyUserId },
    );
    assertEquals(caller.ok, legacyUserId !== "someone-else");
    if (!caller.ok) assertEquals(caller.status, 403);
  }
  const req = new Request("https://local", {
    headers: { Authorization: "Bearer guest" },
  });
  assertEquals(
    (await resolveLabelParseCaller(req, {
      getUser: () => Promise.reject(new Error("auth outage")),
    })).ok,
    false,
  );
});

Deno.test("auth errors fail closed even with a user result", async () => {
  const req = new Request("https://local", {
    headers: { Authorization: "Bearer guest" },
  });
  const caller = await resolveLabelParseCaller(req, {
    getUser: () =>
      Promise.resolve(
        {
          data: { user: { id: "caller" } },
          error: new Error("lookup failed"),
        } as unknown as Awaited<ReturnType<CallerDeps["getUser"]>>,
      ),
  });
  assertEquals(caller.ok, false);
});

export function quotaDeps(overrides: Partial<QuotaDeps> = {}): QuotaDeps {
  return {
    isProUser: () => Promise.resolve(false),
    reserve: () =>
      Promise.resolve({ admitted: true, reservation_id: 1, used: 0 }),
    finalize: () => Promise.resolve(true),
    log: () => {},
    ...overrides,
  };
}
Deno.test("admission uses route-specific free and Pro limits", async () => {
  for (const route of ["primary", "gemini"] as const) {
    for (const proUser of [false, true]) {
      const expected = proUser ? 500 : route === "primary" ? 20 : 10;
      const result = await admitLabelParse(
        quotaDeps({
          isProUser: () => Promise.resolve(proUser),
          reserve: (args) => {
            assertEquals(args, {
              p_user_id: "caller",
              p_units: 2,
              p_limit: expected,
              p_route: route,
            });
            return Promise.resolve({
              admitted: false,
              reservation_id: null,
              used: expected,
            });
          },
        }),
        { userId: "caller", units: 2, route },
      );
      assertEquals(result, {
        admitted: false,
        reservationId: null,
        used: expected,
        limit: expected,
        proUser,
      });
    }
  }
});
Deno.test("accounting errors throw and finalization errors only log", async () => {
  for (
    const override of [
      { isProUser: () => Promise.reject(new Error("Pro lookup")) },
      { reserve: () => Promise.reject(new Error("RPC outage")) },
      {
        reserve: () =>
          Promise.resolve({ admitted: true, reservation_id: null, used: 0 }),
      },
    ]
  ) {
    await assertRejects(() =>
      admitLabelParse(quotaDeps(override), {
        userId: "caller",
        units: 1,
        route: "primary",
      })
    );
  }
  let logs = 0;
  for (
    const finalize of [
      () => Promise.reject(new Error("RPC outage")),
      () => Promise.resolve(false),
    ]
  ) {
    await finalizeLabelParse(
      quotaDeps({
        finalize,
        log: () => {
          logs++;
        },
      }),
      1,
      "succeeded",
    );
  }
  assertEquals(logs, 2);
});

Deno.test("finalization never throws even if logging fails", async () => {
  await finalizeLabelParse(
    quotaDeps({
      finalize: () => Promise.reject(new Error("outage")),
      log: () => {
        throw new Error("logger failed");
      },
    }),
    1,
    "failed_billed",
  );
});
