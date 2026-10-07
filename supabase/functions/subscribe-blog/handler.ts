export interface SubscriptionResult {
  should_send: boolean;
  confirmation_token: string | null;
  unsubscribe_token: string | null;
}

export interface ConfirmationEmail {
  to: string;
  confirmationUrl: string;
  unsubscribeUrl: string;
}

export interface SubscribeBlogDeps {
  getCorsHeaders(origin?: string): Record<string, string>;
  getClientIP(req: Request): string;
  verifyTurnstile(token: string, ip: string): Promise<boolean | "unconfigured">;
  checkIpRate(ip: string): Promise<{ allowed: boolean }>;
  requestSubscription(email: string): Promise<SubscriptionResult>;
  sendConfirmationEmail(email: ConfirmationEmail): Promise<void>;
  logger: { error(message: string): void };
  siteUrl?: string;
}

const SUCCESS = "Subscription successful! Please check your email to confirm.";
const INTERNAL_ERROR = "An internal server error occurred.";

export function createSubscribeBlogHandler(deps: SubscribeBlogDeps) {
  return async (req: Request): Promise<Response> => {
    const cors = deps.getCorsHeaders(req.headers.get("origin") ?? undefined);
    const json = (message: string, status: number) =>
      new Response(JSON.stringify({ message }), {
        status,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: cors });
    }
    if (req.method !== "POST") return json("Method Not Allowed", 405);

    let body: Record<string, unknown>;
    try {
      const parsed = await req.json();
      body = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return json("Invalid email address provided.", 400);
    }
    const token = typeof body.turnstileToken === "string"
      ? body.turnstileToken.trim()
      : "";
    if (!token) return json("CAPTCHA verification token missing.", 400);
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json("Invalid email address provided.", 400);
    }

    const ip = deps.getClientIP(req);
    try {
      const rate = await deps.checkIpRate(ip);
      if (!rate.allowed) {
        return json("Too many requests. Please try again later.", 429);
      }
    } catch {
      deps.logger.error("Subscription rate limit check failed.");
      return json(INTERNAL_ERROR, 500);
    }

    let verified: boolean | "unconfigured";
    try {
      verified = await deps.verifyTurnstile(token, ip);
    } catch {
      verified = false;
    }
    if (verified === "unconfigured") {
      return json("Subscriptions are temporarily unavailable.", 503);
    }
    if (verified !== true) {
      return json("CAPTCHA verification failed. Please try again.", 403);
    }

    let subscription: SubscriptionResult;
    try {
      subscription = await deps.requestSubscription(email.toLowerCase());
      if (
        typeof subscription.should_send !== "boolean" ||
        (subscription.should_send &&
          (!subscription.confirmation_token || !subscription.unsubscribe_token))
      ) throw new Error("Invalid subscription result");
    } catch {
      deps.logger.error("Subscription database request failed.");
      return json(INTERNAL_ERROR, 500);
    }

    if (subscription.should_send) {
      const site = (deps.siteUrl || "https://www.timer.coffee").replace(
        /\/$/,
        "",
      );
      try {
        await deps.sendConfirmationEmail({
          to: email.toLowerCase(),
          confirmationUrl:
            `${site}/api/confirm?token=${subscription.confirmation_token}`,
          unsubscribeUrl:
            `${site}/api/unsubscribe?token=${subscription.unsubscribe_token}`,
        });
      } catch {
        // Provider errors may contain addresses or capability tokens.
        deps.logger.error("Subscription confirmation email failed.");
      }
    }
    return json(SUCCESS, 200);
  };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function confirmationEmailContent(email: ConfirmationEmail) {
  const confirm = escapeHtml(email.confirmationUrl);
  const unsubscribe = escapeHtml(email.unsubscribeUrl);
  return {
    html:
      `<div style="font-family: Inter, Arial, sans-serif; line-height: 1.6; color: #333; padding: 20px; border: 1px solid #eee; max-width: 600px;">
<h2>Welcome to Timer.Coffee — you’re almost in!</h2>
<p>Thank you for joining our coffee community. We’ll email you whenever we publish a new blog post.</p>
<p>To start receiving emails, please confirm your address:</p>
<p><a href="${confirm}" style="display: inline-block; padding: 10px 15px; background: #007bff; color: white; border-radius: 5px; text-decoration: none;">Confirm my subscription</a></p>
<p>If the button isn’t displaying, copy and paste this link into your browser:</p>
<p>${confirm}</p>
<hr>
<p style="font-size: 12px; color: #777;">Didn’t sign up for Timer.Coffee? Just ignore this email and you won’t be subscribed.</p>
<p style="font-size: 12px; color: #777;">Manage your preferences or unsubscribe any time: <a href="${unsubscribe}">Unsubscribe</a></p>
</div>`,
    text:
      `Welcome! Confirm your subscription to the Timer.Coffee blog by visiting: ${email.confirmationUrl} \n\nUnsubscribe: ${email.unsubscribeUrl}`,
  };
}
