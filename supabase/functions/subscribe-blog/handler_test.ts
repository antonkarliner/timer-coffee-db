import {
  type ConfirmationEmail,
  confirmationEmailContent,
  createSubscribeBlogHandler,
  type SubscribeBlogDeps,
} from "./handler.ts";

function assert(ok: unknown, message = "Assertion failed"): asserts ok {
  if (!ok) throw new Error(message);
}

const address = "private-person@example.com";
const confirmationToken = "11111111-1111-4111-8111-111111111111";
const unsubscribeToken = "22222222-2222-4222-8222-222222222222";
const success = {
  message: "Subscription successful! Please check your email to confirm.",
};
const sensitiveError = new Error(
  `${address} ${confirmationToken} ${unsubscribeToken}`,
);

function fixture(overrides: Partial<SubscribeBlogDeps> = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const emails: ConfirmationEmail[] = [];
  const deps: SubscribeBlogDeps = {
    getCorsHeaders: () => ({
      "Access-Control-Allow-Origin": "https://test.site",
    }),
    getClientIP: () => "192.0.2.1",
    checkIpRate: (ip) => {
      assert(ip === "192.0.2.1");
      calls.push("rate");
      return Promise.resolve({ allowed: true });
    },
    verifyTurnstile: (token, ip) => {
      assert(token === "captcha" && ip === "192.0.2.1");
      calls.push("turnstile");
      return Promise.resolve(true);
    },
    requestSubscription: (email) => {
      assert(email === address);
      calls.push("rpc");
      return Promise.resolve({
        should_send: true,
        confirmation_token: confirmationToken,
        unsubscribe_token: unsubscribeToken,
      });
    },
    sendConfirmationEmail: (email) => {
      calls.push("email");
      emails.push(email);
      return Promise.resolve();
    },
    logger: { error: (message) => logs.push(message) },
    ...overrides,
  };
  return { handler: createSubscribeBlogHandler(deps), calls, logs, emails };
}

function request(
  body: unknown = { email: address, turnstileToken: "captcha" },
) {
  return new Request("https://test.site", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function expectResponse(
  response: Response,
  status: number,
  message: string,
  logs: string[] = [],
) {
  assert(response.status === status);
  assert(
    response.headers.get("Access-Control-Allow-Origin") === "https://test.site",
  );
  const text = await response.text();
  assert(text === JSON.stringify({ message }), text);
  for (const value of [address, confirmationToken, unsubscribeToken]) {
    assert(!text.includes(value) && !logs.join("\n").includes(value));
  }
}

Deno.test("OPTIONS and unsupported methods have CORS and no effects", async () => {
  const f = fixture();
  const options = await f.handler(
    new Request("https://test.site", { method: "OPTIONS" }),
  );
  assert(options.status === 200);
  assert(
    options.headers.get("Access-Control-Allow-Origin") === "https://test.site",
  );
  await expectResponse(
    await f.handler(new Request("https://test.site")),
    405,
    "Method Not Allowed",
  );
  assert(f.calls.length === 0);
});

Deno.test("missing, empty and non-string CAPTCHA tokens fail validation", async () => {
  for (const token of [undefined, "", "  ", 123]) {
    const f = fixture();
    await expectResponse(
      await f.handler(request({ email: address, turnstileToken: token })),
      400,
      "CAPTCHA verification token missing.",
    );
    assert(f.calls.length === 0);
  }
});

Deno.test("invalid emails, oversized emails and malformed JSON fail validation", async () => {
  for (
    const email of [
      undefined,
      "",
      "x",
      "a@b",
      "a b@c.d",
      "a@b@c.d",
      `${"a".repeat(249)}@b.com`,
      123,
    ]
  ) {
    const f = fixture();
    await expectResponse(
      await f.handler(request({ email, turnstileToken: "captcha" })),
      400,
      "Invalid email address provided.",
    );
    assert(f.calls.length === 0);
  }
  const f = fixture();
  await expectResponse(
    await f.handler(
      new Request("https://test.site", { method: "POST", body: "{" }),
    ),
    400,
    "Invalid email address provided.",
  );
  await expectResponse(
    await f.handler(request(null)),
    400,
    "CAPTCHA verification token missing.",
  );
});

Deno.test("rate denial and rate errors stop before Turnstile and RPC", async () => {
  for (const throws of [false, true]) {
    const f = fixture({
      checkIpRate: () => {
        if (throws) throw sensitiveError;
        return Promise.resolve({ allowed: false });
      },
    });
    await expectResponse(
      await f.handler(request()),
      throws ? 500 : 429,
      throws
        ? "An internal server error occurred."
        : "Too many requests. Please try again later.",
      f.logs,
    );
    assert(f.calls.length === 0);
  }
});

Deno.test("unconfigured, rejected and errored Turnstile stop before RPC", async () => {
  for (const result of ["unconfigured", false, "throw"] as const) {
    const f = fixture({
      verifyTurnstile: () => {
        if (result === "throw") throw sensitiveError;
        return Promise.resolve(result);
      },
    });
    await expectResponse(
      await f.handler(request()),
      result === "unconfigured" ? 503 : 403,
      result === "unconfigured"
        ? "Subscriptions are temporarily unavailable."
        : "CAPTCHA verification failed. Please try again.",
      f.logs,
    );
    assert(f.calls.join(",") === "rate");
  }
});

Deno.test("RPC errors and malformed results fail closed without leaking", async () => {
  for (const malformed of [false, true]) {
    const f = fixture({
      requestSubscription: () => {
        if (!malformed) throw sensitiveError;
        return Promise.resolve({
          should_send: true,
          confirmation_token: null,
          unsubscribe_token: null,
        });
      },
    });
    await expectResponse(
      await f.handler(request()),
      500,
      "An internal server error occurred.",
      f.logs,
    );
    assert(f.calls.join(",") === "rate,turnstile");
    assert(f.emails.length === 0);
  }
});

Deno.test("new, pending and confirmed addresses have identical successful responses", async () => {
  for (const state of ["new", "pending", "confirmed"]) {
    const f = fixture(
      state === "confirmed"
        ? {
          requestSubscription: () =>
            Promise.resolve({
              should_send: false,
              confirmation_token: null,
              unsubscribe_token: null,
            }),
        }
        : {},
    );
    await expectResponse(
      await f.handler(
        request({
          email: `  ${address.toUpperCase()}  `,
          turnstileToken: " captcha ",
        }),
      ),
      200,
      success.message,
      f.logs,
    );
    assert(f.emails.length === (state === "confirmed" ? 0 : 1));
    if (state !== "confirmed") {
      assert(f.calls.join(",") === "rate,turnstile,rpc,email");
      assert(f.emails[0].to === address);
      assert(
        f.emails[0].confirmationUrl ===
          `https://www.timer.coffee/api/confirm?token=${confirmationToken}`,
      );
      assert(
        f.emails[0].unsubscribeUrl ===
          `https://www.timer.coffee/api/unsubscribe?token=${unsubscribeToken}`,
      );
    }
  }
});

Deno.test("async client IP reaches rate limiting and Turnstile", async () => {
  const resolvedIP = "203.0.113.7";
  const seen: string[] = [];
  const f = fixture({
    getClientIP: () => Promise.resolve(resolvedIP),
    checkIpRate: (ip) => {
      seen.push(ip);
      return Promise.resolve({ allowed: true });
    },
    verifyTurnstile: (_token, ip) => {
      seen.push(ip);
      return Promise.resolve(true);
    },
  });
  await expectResponse(await f.handler(request()), 200, success.message);
  assert(seen.length === 2 && seen.every((ip) => ip === resolvedIP));
});

Deno.test("email failure still succeeds with sanitized logs", async () => {
  const f = fixture({
    sendConfirmationEmail: () => {
      throw sensitiveError;
    },
  });
  await expectResponse(
    await f.handler(request()),
    200,
    success.message,
    f.logs,
  );
  assert(f.logs.length === 1);
  assert(f.calls.join(",") === "rate,turnstile,rpc");
});

Deno.test("custom site links and HTML escaping preserve email wording", async () => {
  const f = fixture({ siteUrl: "https://blog.example/" });
  await f.handler(request());
  assert(
    f.emails[0].confirmationUrl.startsWith("https://blog.example/api/confirm?"),
  );
  const email = {
    to: address,
    confirmationUrl: 'https://example/?x="<&',
    unsubscribeUrl: "https://example/?x='>&",
  };
  const content = confirmationEmailContent(email);
  assert(
    content.html.includes("&quot;&lt;&amp;") &&
      content.html.includes("&#39;&gt;&amp;"),
  );
  assert(!content.html.includes(email.confirmationUrl));
  assert(content.html.includes("Welcome to Timer.Coffee — you’re almost in!"));
  assert(content.html.includes("Confirm my subscription"));
  assert(
    content.text ===
      `Welcome! Confirm your subscription to the Timer.Coffee blog by visiting: ${email.confirmationUrl} \n\nUnsubscribe: ${email.unsubscribeUrl}`,
  );
});
