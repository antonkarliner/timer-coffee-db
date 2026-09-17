import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.223.0/assert/mod.ts";
import {
  buildBatchIdempotencyKey,
  createSanitySignature,
  parseBlogPostPayload,
  renderNotificationHtml,
  verifySanitySignature,
} from "./handler.ts";

Deno.test("verifies an authentic Sanity webhook signature", async () => {
  const body = JSON.stringify({ _id: "post-1", title: "Test", slug: "test" });
  const signature = await createSanitySignature(
    body,
    1_800_000_000_000,
    "secret",
  );

  assert(await verifySanitySignature(body, signature, "secret"));
  assertEquals(
    await verifySanitySignature(`${body} `, signature, "secret"),
    false,
  );
  assertEquals(
    await verifySanitySignature(body, signature, "wrong-secret"),
    false,
  );
});

Deno.test("rejects malformed blog post payloads", () => {
  assertEquals(parseBlogPostPayload({ _id: "post-1", title: "Test" }), null);
  assertEquals(parseBlogPostPayload(null), null);
});

Deno.test("normalizes a projected blog post payload", () => {
  assertEquals(
    parseBlogPostPayload({
      _id: " post-1 ",
      title: " New post ",
      slug: " new-post ",
      excerpt: " A summary ",
    }),
    {
      _id: "post-1",
      title: "New post",
      slug: "new-post",
      excerpt: "A summary",
      heroImageUrl: undefined,
      heroImageAlt: undefined,
    },
  );
});

Deno.test("escapes untrusted post fields in email HTML", () => {
  const html = renderNotificationHtml({
    post: {
      _id: "post-1",
      title: '<script>alert("x")</script>',
      slug: "post-1",
      excerpt: "Coffee & tea",
    },
    postUrl: "https://www.timer.coffee/blog/post-1",
    unsubscribeUrl:
      "https://www.timer.coffee/api/unsubscribe?token=abc&source=email",
  });

  assertStringIncludes(
    html,
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
  );
  assertStringIncludes(html, "Coffee &amp; tea");
  assertStringIncludes(html, "token=abc&amp;source=email");
});

Deno.test("builds stable per-batch Resend idempotency keys", () => {
  assertEquals(
    buildBatchIdempotencyKey("drafts.post/with spaces", 2),
    "blog-post/drafts_post_with_spaces/batch/2",
  );
});
