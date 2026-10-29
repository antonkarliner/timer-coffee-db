import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.223.0/assert/mod.ts";
import {
  buildWebRiskSearchUrl,
  createWebRiskClient,
  WEB_RISK_SEARCH_URL,
  type WebRiskFetch,
} from "./web-risk.ts";

const API_KEY = "test-web-risk-key-123";

type Call = { url: string; init: RequestInit; timeoutMs: number };

function recordingFetch(
  respond: (call: Call) => Response | Promise<Response>,
): { fetch: WebRiskFetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch(url, init, timeoutMs) {
      const call = { url, init, timeoutMs };
      calls.push(call);
      return Promise.resolve(respond(call));
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("buildWebRiskSearchUrl asks for the three threat lists and encodes the URI", () => {
  const url = new URL(
    buildWebRiskSearchUrl("https://evil.example/path?a=1&b=2#frag"),
  );
  assertEquals(`${url.origin}${url.pathname}`, WEB_RISK_SEARCH_URL);
  assertEquals(url.searchParams.getAll("threatTypes"), [
    "MALWARE",
    "SOCIAL_ENGINEERING",
    "UNWANTED_SOFTWARE",
  ]);
  assertEquals(
    url.searchParams.get("uri"),
    "https://evil.example/path?a=1&b=2#frag",
  );
  // The URI's own query must not leak into the search URL's parameters.
  assertEquals(url.searchParams.get("a"), null);
  assertEquals(url.searchParams.get("key"), null);
});

Deno.test("lookUp sends the key only in the X-Goog-Api-Key header", async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse(200, {}));
  const client = createWebRiskClient({ apiKey: API_KEY, fetch });

  const result = await client.lookUp("https://example.com/");

  assertEquals(result, { status: "clean" });
  assertEquals(calls.length, 1);
  assert(!calls[0].url.includes(API_KEY), "key must not be in the URL");
  const headers = new Headers(calls[0].init.headers);
  assertEquals(headers.get("X-Goog-Api-Key"), API_KEY);
  assertEquals(calls[0].init.method, "GET");
  assertEquals(calls[0].timeoutMs, 5000);
});

Deno.test("lookUp reports flagged threat types", async () => {
  const { fetch } = recordingFetch(() =>
    jsonResponse(200, {
      threat: {
        threatTypes: ["SOCIAL_ENGINEERING", 7, "MALWARE"],
        expireTime: "2026-10-30T00:00:00Z",
      },
    })
  );
  const client = createWebRiskClient({ apiKey: API_KEY, fetch });
  assertEquals(await client.lookUp("https://evil.example/"), {
    status: "flagged",
    threatTypes: ["SOCIAL_ENGINEERING", "MALWARE"],
  });
});

Deno.test("lookUp marks a threat without types as unspecified", async () => {
  const { fetch } = recordingFetch(() => jsonResponse(200, { threat: {} }));
  const client = createWebRiskClient({ apiKey: API_KEY, fetch });
  assertEquals(await client.lookUp("https://evil.example/"), {
    status: "flagged",
    threatTypes: ["THREAT_TYPE_UNSPECIFIED"],
  });
});

Deno.test("lookUp classifies 429 and RESOURCE_EXHAUSTED as quota", async () => {
  const tooMany = createWebRiskClient({
    apiKey: API_KEY,
    fetch: recordingFetch(() => new Response("slow down", { status: 429 }))
      .fetch,
  });
  assertEquals(await tooMany.lookUp("https://example.com/"), {
    status: "quota",
    httpStatus: 429,
  });

  const exhausted = createWebRiskClient({
    apiKey: API_KEY,
    fetch: recordingFetch(() =>
      jsonResponse(403, {
        error: { code: 403, status: "RESOURCE_EXHAUSTED", message: "Quota" },
      })
    ).fetch,
  });
  assertEquals(await exhausted.lookUp("https://example.com/"), {
    status: "quota",
    httpStatus: 403,
  });
});

Deno.test("lookUp classifies a refused key as auth_error", async () => {
  const invalidKey = createWebRiskClient({
    apiKey: API_KEY,
    fetch: recordingFetch(() =>
      jsonResponse(400, {
        error: {
          code: 400,
          status: "INVALID_ARGUMENT",
          details: [{ reason: "API_KEY_INVALID" }],
        },
      })
    ).fetch,
  });
  assertEquals(await invalidKey.lookUp("https://example.com/"), {
    status: "auth_error",
    httpStatus: 400,
  });

  const forbidden = createWebRiskClient({
    apiKey: API_KEY,
    fetch: recordingFetch(() =>
      jsonResponse(403, { error: { status: "PERMISSION_DENIED" } })
    ).fetch,
  });
  assertEquals(await forbidden.lookUp("https://example.com/"), {
    status: "auth_error",
    httpStatus: 403,
  });
});

Deno.test("lookUp reports other failures as per-lookup errors", async () => {
  const serverError = createWebRiskClient({
    apiKey: API_KEY,
    fetch: recordingFetch(() => new Response("oops", { status: 503 })).fetch,
  });
  assertEquals(await serverError.lookUp("https://example.com/"), {
    status: "error",
    reason: "http",
    httpStatus: 503,
  });

  const network = createWebRiskClient({
    apiKey: API_KEY,
    fetch: () => Promise.reject(new TypeError("connection reset")),
  });
  assertEquals(await network.lookUp("https://example.com/"), {
    status: "error",
    reason: "network",
  });

  const garbage = createWebRiskClient({
    apiKey: API_KEY,
    fetch: recordingFetch(() => new Response("<html>", { status: 200 })).fetch,
  });
  assertEquals(await garbage.lookUp("https://example.com/"), {
    status: "error",
    reason: "invalid_response",
  });

  const notAnObject = createWebRiskClient({
    apiKey: API_KEY,
    fetch: recordingFetch(() => jsonResponse(200, ["nope"])).fetch,
  });
  assertEquals(await notAnObject.lookUp("https://example.com/"), {
    status: "error",
    reason: "invalid_response",
  });
});

Deno.test("lookUp times out through the shared fetchWithTimeout without leaking the URL or key", async () => {
  const originalFetch = globalThis.fetch;
  const seenUrls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    seenUrls.push(String(input instanceof Request ? input.url : input));
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  }) as typeof fetch;
  try {
    const client = createWebRiskClient({ apiKey: API_KEY, timeoutMs: 20 });
    const result = await client.lookUp("https://slow.example/secret?token=1");
    assertEquals(result, { status: "error", reason: "timeout" });
    // The classified result carries no message, URL or key.
    assert(!JSON.stringify(result).includes("slow.example"));
    assert(!JSON.stringify(result).includes(API_KEY));
    assertEquals(seenUrls.length, 1);
    assert(!seenUrls[0].includes(API_KEY));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
