import {
  PROXY_CLIENT_IP_HEADER,
  PROXY_CLIENT_IP_SIGNATURE_HEADER,
  signProxyClientIP,
  verifyProxyClientIP,
} from "./proxy-client-ip.ts";

function assert(ok: unknown, message = "Assertion failed"): asserts ok {
  if (!ok) throw new Error(message);
}

const secret = "test-secret";
const audience = "subscribe-blog";
const ip = "203.0.113.7";
const now = 1791400000000;
// Independently confirmed with Node crypto.createHmac('sha256', 'test-secret').
const vector =
  "v1.1791400000.60bc55821b0c6a094cc935ba6bbb748aa5d2877637bcc51e44784564a13ce503";

function request(assertedIP: string = ip, signature: string = vector) {
  return new Request("https://test.site", {
    headers: {
      [PROXY_CLIENT_IP_HEADER]: assertedIP,
      [PROXY_CLIENT_IP_SIGNATURE_HEADER]: signature,
    },
  });
}

Deno.test("fixed HMAC vector and valid round trips", async () => {
  assert(await signProxyClientIP(secret, audience, ip, now) === vector);
  assert(
    await signProxyClientIP(secret, "submit-roaster-feedback", ip, now) ===
      "v1.1791400000.ac7214e207954dddd59ee75e43bfd448335b7caea66508112e43f798047814f6",
  );
  for (const address of [ip, "2001:db8::1", "::ffff:203.0.113.7"]) {
    const signature = await signProxyClientIP(secret, audience, address, now);
    assert(
      await verifyProxyClientIP(
        request(address, signature),
        secret,
        audience,
        now,
      ) === address,
    );
  }
});

Deno.test("wrong secret, audience and tampered IP are rejected", async () => {
  assert(await verifyProxyClientIP(request(), "wrong", audience, now) === null);
  assert(
    await verifyProxyClientIP(request(), secret, "other-function", now) ===
      null,
  );
  assert(
    await verifyProxyClientIP(request("203.0.113.8"), secret, audience, now) ===
      null,
  );
});

Deno.test("timestamps accept both 60 second boundaries and reject 61 seconds", async () => {
  for (const offset of [-61, -60, 60, 61]) {
    const signature = await signProxyClientIP(
      secret,
      audience,
      ip,
      now + offset * 1000,
    );
    const result = await verifyProxyClientIP(
      request(ip, signature),
      secret,
      audience,
      now,
    );
    assert(result === (Math.abs(offset) <= 60 ? ip : null));
  }
});

Deno.test("missing or empty secrets and missing headers are rejected", async () => {
  for (const missingSecret of [undefined, ""]) {
    assert(
      await verifyProxyClientIP(request(), missingSecret, audience, now) ===
        null,
    );
  }
  for (
    const header of [PROXY_CLIENT_IP_HEADER, PROXY_CLIENT_IP_SIGNATURE_HEADER]
  ) {
    const req = request();
    req.headers.delete(header);
    assert(await verifyProxyClientIP(req, secret, audience, now) === null);
  }
  assert(
    await verifyProxyClientIP(
      new Request("https://test.site"),
      secret,
      audience,
      now,
    ) === null,
  );
});

Deno.test("malformed signatures are rejected without throwing", async () => {
  for (
    const signature of [
      vector.replace("v1.", "v2."),
      `v1.1791400000.${"g".repeat(64)}`,
      vector.slice(0, -1),
      `${vector}0`,
      vector.replace("1791400000", "not-seconds"),
      `${vector}.extra`,
      "",
    ]
  ) {
    assert(
      await verifyProxyClientIP(
        request(ip, signature),
        secret,
        audience,
        now,
      ) === null,
    );
  }
});

Deno.test("invalid asserted IP strings are rejected even with matching HMACs", async () => {
  for (
    const address of [
      "1.2.3.4, 5.6.7.8",
      "<script>",
      `:${"a".repeat(45)}`,
      "",
      "abcdef",
    ]
  ) {
    const signature = await signProxyClientIP(secret, audience, address, now);
    assert(
      await verifyProxyClientIP(
        request(address, signature),
        secret,
        audience,
        now,
      ) === null,
    );
  }
});
