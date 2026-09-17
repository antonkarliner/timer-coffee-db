export const SANITY_SIGNATURE_HEADER = "sanity-webhook-signature";

const SIGNATURE_HEADER_PATTERN = /^t=(\d+)[, ]+v1=([^, ]+)$/;
const MINIMUM_TIMESTAMP = 1_609_459_200_000;

export interface BlogPostWebhookPayload {
  _id: string;
  title: string;
  slug: string;
  excerpt?: string;
  heroImageUrl?: string;
  heroImageAlt?: string;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;

  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function createSanitySignature(
  rawBody: string,
  timestamp: number,
  secret: string,
): Promise<string> {
  if (
    !rawBody || !secret || !Number.isFinite(timestamp) ||
    timestamp < MINIMUM_TIMESTAMP
  ) {
    throw new Error("Invalid Sanity signature input");
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${rawBody}`),
  );

  return `t=${timestamp},v1=${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifySanitySignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  const match = signatureHeader.trim().match(SIGNATURE_HEADER_PATTERN);
  if (!match) return false;

  const timestamp = Number.parseInt(match[1], 10);
  if (!Number.isFinite(timestamp) || timestamp < MINIMUM_TIMESTAMP) {
    return false;
  }

  const expected = await createSanitySignature(rawBody, timestamp, secret);
  return constantTimeEqual(signatureHeader.trim(), expected);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function parseBlogPostPayload(
  value: unknown,
): BlogPostWebhookPayload | null {
  if (typeof value !== "object" || value === null) return null;

  const payload = value as Record<string, unknown>;
  const id = optionalString(payload._id);
  const title = optionalString(payload.title);
  const slug = optionalString(payload.slug);
  if (!id || !title || !slug) return null;

  return {
    _id: id,
    title,
    slug,
    excerpt: optionalString(payload.excerpt),
    heroImageUrl: optionalString(payload.heroImageUrl),
    heroImageAlt: optionalString(payload.heroImageAlt),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderNotificationHtml(options: {
  post: BlogPostWebhookPayload;
  postUrl: string;
  unsubscribeUrl: string;
}): string {
  const { post, postUrl, unsubscribeUrl } = options;
  const safeTitle = escapeHtml(post.title);
  const heroImage = post.heroImageUrl
    ? `<img src="${escapeHtml(post.heroImageUrl)}" alt="${
      escapeHtml(post.heroImageAlt ?? post.title)
    }" style="width:100%;max-width:560px;display:block;margin-bottom:16px;border-radius:4px;" />`
    : "";
  const excerpt = post.excerpt
    ? `<p style="margin:16px 0;">${escapeHtml(post.excerpt)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#ffffff;">
    <div style="font-family:Inter,Arial,sans-serif;line-height:1.6;color:#333;padding:20px;border:1px solid #eee;max-width:600px;margin:20px auto;">
      ${heroImage}
      <h2 style="color:#000;margin-top:0;">New on the blog: ${safeTitle}</h2>
      ${excerpt}
      <p style="margin:16px 0;">Have a look 👉 <a href="${
    escapeHtml(postUrl)
  }" style="color:#0052cc;text-decoration:none;">Read the full post</a></p>
      <hr />
      <p style="font-size:0.85rem;color:#666;">You received this email because you subscribed to updates from Timer.Coffee. If that was a mistake, you can <a href="${
    escapeHtml(unsubscribeUrl)
  }" style="color:#0052cc;text-decoration:none;">unsubscribe here</a>.</p>
    </div>
  </body>
</html>`;
}

export function renderNotificationText(options: {
  post: BlogPostWebhookPayload;
  postUrl: string;
  unsubscribeUrl: string;
}): string {
  const { post, postUrl, unsubscribeUrl } = options;
  return [
    `New Post: ${post.title}`,
    "",
    post.excerpt ?? "",
    "",
    `Read more: ${postUrl}`,
    "",
    `Unsubscribe: ${unsubscribeUrl}`,
  ].join("\n");
}

export function buildBatchIdempotencyKey(
  postId: string,
  batchIndex: number,
): string {
  const normalizedPostId = postId.replaceAll(/[^A-Za-z0-9_-]/g, "_").slice(
    0,
    180,
  );
  return `blog-post/${normalizedPostId}/batch/${batchIndex}`;
}
