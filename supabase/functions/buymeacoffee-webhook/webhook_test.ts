import {
  computeHmacSha256,
  computeSha256,
  constantTimeEquals,
  normalizeSignature,
  resolveWebhookSecret,
  sanitizePayload,
} from "./webhook.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function env(
  values: Record<string, string>,
): (name: string) => string | undefined {
  return (name) => values[name];
}

Deno.test("event-specific key wins over map and shared key", () => {
  assertEquals(
    resolveWebhookSecret(
      "support_created",
      env({
        BUYMEACOFFEE_WEBHOOK_SECRET_SUPPORT_CREATED: "event-key",
        BUYMEACOFFEE_WEBHOOK_SECRETS: '{"support_created":"mapped-key"}',
        BUYMEACOFFEE_WEBHOOK_SECRET: "shared-key",
      }),
    ),
    { secret: "event-key", source: "event_specific_env" },
  );
});

Deno.test("mapped key wins over shared key when event-specific key is absent", () => {
  assertEquals(
    resolveWebhookSecret(
      "support_created",
      env({
        BUYMEACOFFEE_WEBHOOK_SECRETS: '{"support_created":"mapped-key"}',
        BUYMEACOFFEE_WEBHOOK_SECRET: "shared-key",
      }),
    ),
    { secret: "mapped-key", source: "json_env_map" },
  );
});

Deno.test("shared key is used when neither event-specific nor mapped key exists", () => {
  assertEquals(
    resolveWebhookSecret(
      "support_created",
      env({
        BUYMEACOFFEE_WEBHOOK_SECRETS: '{"support_refunded":"other-key"}',
        BUYMEACOFFEE_WEBHOOK_SECRET: "shared-key",
      }),
    ),
    { secret: "shared-key", source: "shared_env" },
  );
});

Deno.test("empty and non-string mapped entries fall through to shared key", () => {
  for (const entry of ["", null, 123, false, {}, []]) {
    assertEquals(
      resolveWebhookSecret(
        "support_created",
        env({
          BUYMEACOFFEE_WEBHOOK_SECRETS: JSON.stringify({
            support_created: entry,
          }),
          BUYMEACOFFEE_WEBHOOK_SECRET: "shared-key",
        }),
      ),
      { secret: "shared-key", source: "shared_env" },
    );
  }
});

Deno.test("URL-supplied signing key cannot override shared configuration", async () => {
  const request = new Request(
    "https://example.test/webhook?kind=support_created&secret=attacker-key",
  );
  const kind = new URL(request.url).searchParams.get("kind")!;
  const { secret, source } = resolveWebhookSecret(
    kind,
    env({
      BUYMEACOFFEE_WEBHOOK_SECRET: "shared-key",
    }),
  );
  assertEquals(source, "shared_env");
  assertEquals(secret, "shared-key");
  const body = '{"event_id":"forged"}';
  const forged = await computeHmacSha256("attacker-key", body);
  const expected = await computeHmacSha256(secret!, body);
  assertEquals(constantTimeEquals(forged, expected), false);
});

Deno.test("missing or empty configuration yields no key", () => {
  assertEquals(resolveWebhookSecret("support_created", env({})), {
    secret: null,
    source: "missing",
  });
  assertEquals(
    resolveWebhookSecret(
      "support_created",
      env({
        BUYMEACOFFEE_WEBHOOK_SECRET_SUPPORT_CREATED: "",
        BUYMEACOFFEE_WEBHOOK_SECRETS: '{"support_created":""}',
        BUYMEACOFFEE_WEBHOOK_SECRET: "",
      }),
    ),
    { secret: null, source: "missing" },
  );
});

Deno.test("invalid map JSON logs no value and falls through to shared key", () => {
  const logs: string[] = [];
  assertEquals(
    resolveWebhookSecret(
      "support_created",
      env({
        BUYMEACOFFEE_WEBHOOK_SECRETS: '{"private-key": secret-value}',
        BUYMEACOFFEE_WEBHOOK_SECRET: "shared-key",
      }),
      (message) => logs.push(message),
    ),
    {
      secret: "shared-key",
      source: "shared_env",
    },
  );
  assertEquals(logs, ["Invalid BUYMEACOFFEE_WEBHOOK_SECRETS JSON"]);
});

Deno.test("signature normalization preserves prefix, case and whitespace handling", () => {
  assertEquals(normalizeSignature(" \tSHA256=AbCdEF\n"), "abcdef");
  assertEquals(normalizeSignature(" \tAbCdEF\n"), "abcdef");
  assertEquals(normalizeSignature(null), null);
  assertEquals(normalizeSignature(""), null);
  assertEquals(normalizeSignature("  "), "");
});

Deno.test("known HMAC accepted; one-byte signature change and length mismatch rejected", async () => {
  const signature = await computeHmacSha256(
    "key",
    "The quick brown fox jumps over the lazy dog",
  );
  assertEquals(
    signature,
    "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
  );
  assertEquals(
    constantTimeEquals(
      normalizeSignature(` SHA256=${signature.toUpperCase()} `)!,
      signature,
    ),
    true,
  );
  assertEquals(constantTimeEquals(`f6${signature.slice(2)}`, signature), false);
  assertEquals(constantTimeEquals(signature.slice(2), signature), false);
});

Deno.test("HMAC and payload hash use raw body text including whitespace", async () => {
  const compact = '{"amount":1}';
  const spaced = '{ "amount": 1 }\n';
  const signature = await computeHmacSha256("key", compact);
  assertEquals(
    constantTimeEquals(signature, await computeHmacSha256("key", spaced)),
    false,
  );
  assertEquals(
    await computeSha256(compact) === await computeSha256(spaced),
    false,
  );
  assertEquals(
    await computeSha256("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("sanitization removes only private data fields and does not mutate input", () => {
  const data = {
    message: "private",
    supporter_email: "private",
    supporter_name: "private",
    supporter_name_type: "private",
    support_note: "private",
    supporter_feedback: "private",
    supporter_id: "private",
    amount: "1",
    currency: "USD",
  };
  const payload = { event_id: "synthetic", data };
  const original = structuredClone(payload);
  assertEquals(sanitizePayload(payload), {
    event_id: "synthetic",
    data: { amount: "1", currency: "USD" },
  });
  assertEquals(payload, original);
  for (const value of [null, "text", 1, { data: null }]) {
    assertEquals(sanitizePayload(value), value);
  }
});
