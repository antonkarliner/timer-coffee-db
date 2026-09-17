import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { createSecureResponse } from "../_shared/security-headers.ts";
import {
  buildBatchIdempotencyKey,
  parseBlogPostPayload,
  renderNotificationHtml,
  renderNotificationText,
  SANITY_SIGNATURE_HEADER,
  verifySanitySignature,
} from "./handler.ts";

const RESEND_BATCH_SIZE = 100;
const SUBSCRIBER_PAGE_SIZE = 1_000;
const DEFAULT_SITE_URL = "https://www.timer.coffee";
const DEFAULT_SENDER = "Timer.Coffee Blog <noreply@timer.coffee>";

interface Subscriber {
  id: string;
  email: string;
  token: string;
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return createSecureResponse(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const sanityWebhookSecret = Deno.env.get("SANITY_WEBHOOK_SECRET") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    "";
  const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? "";
  const siteUrl = (Deno.env.get("BLOG_SITE_URL") ?? DEFAULT_SITE_URL).replace(
    /\/$/,
    "",
  );
  const senderEmail = Deno.env.get("BLOG_SENDER_EMAIL") ?? DEFAULT_SENDER;

  if (
    !sanityWebhookSecret || !supabaseUrl || !supabaseServiceRoleKey ||
    !resendApiKey
  ) {
    console.error(
      "[notify-blog-subscribers] Required environment is not configured",
    );
    return jsonResponse({ error: "Server configuration error" }, 500);
  }

  try {
    const signature = req.headers.get(SANITY_SIGNATURE_HEADER);
    if (!signature) {
      return jsonResponse({ error: "Missing signature" }, 401);
    }

    const rawBody = await req.text();
    if (!await verifySanitySignature(rawBody, signature, sanityWebhookSecret)) {
      return jsonResponse({ error: "Invalid signature" }, 401);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ error: "Invalid JSON payload" }, 400);
    }

    const post = parseBlogPostPayload(parsed);
    if (!post) {
      return jsonResponse({ error: "Invalid blog post payload" }, 400);
    }

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const subscribers: Subscriber[] = [];

    for (let start = 0;; start += SUBSCRIBER_PAGE_SIZE) {
      const { data, error } = await supabase
        .from("blog_subscribers")
        .select("id, email, token")
        .eq("confirmed", true)
        .order("id", { ascending: true })
        .range(start, start + SUBSCRIBER_PAGE_SIZE - 1);

      if (error) {
        console.error(
          "[notify-blog-subscribers] Subscriber query failed",
          error.code,
        );
        return jsonResponse({ error: "Failed to fetch subscribers" }, 500);
      }

      const page = (data ?? []) as Subscriber[];
      subscribers.push(...page);
      if (page.length < SUBSCRIBER_PAGE_SIZE) break;
    }

    if (subscribers.length === 0) {
      return jsonResponse({
        message: "No confirmed subscribers found",
        sent: 0,
      }, 200);
    }

    const postUrl = `${siteUrl}/blog/${encodeURIComponent(post.slug)}`;
    const heroImageUrl = post.heroImageUrl
      ? `${post.heroImageUrl}${
        post.heroImageUrl.includes("?") ? "&" : "?"
      }w=600&auto=format`
      : undefined;
    const emailPost = { ...post, heroImageUrl };
    let sent = 0;

    for (
      const [batchIndex, batch] of chunk(subscribers, RESEND_BATCH_SIZE)
        .entries()
    ) {
      const messages = batch.map((subscriber) => {
        const unsubscribeUrl = `${siteUrl}/api/unsubscribe?token=${
          encodeURIComponent(subscriber.token)
        }`;
        return {
          from: senderEmail,
          to: [subscriber.email],
          subject: `New Post: ${post.title}`,
          html: renderNotificationHtml({
            post: emailPost,
            postUrl,
            unsubscribeUrl,
          }),
          text: renderNotificationText({
            post: emailPost,
            postUrl,
            unsubscribeUrl,
          }),
        };
      });

      const resendResponse = await fetch(
        "https://api.resend.com/emails/batch",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": buildBatchIdempotencyKey(post._id, batchIndex),
          },
          body: JSON.stringify(messages),
        },
      );

      if (!resendResponse.ok) {
        console.error(
          "[notify-blog-subscribers] Resend batch failed",
          resendResponse.status,
        );
        return jsonResponse({ error: "Email delivery failed", sent }, 502);
      }

      sent += batch.length;
    }

    console.log("[notify-blog-subscribers] Delivery complete", {
      postId: post._id,
      sent,
    });
    return jsonResponse(
      { message: "Notification delivery complete", sent },
      200,
    );
  } catch (error) {
    console.error(
      "[notify-blog-subscribers] Unexpected error",
      error instanceof Error ? error.message : String(error),
    );
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
