import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
import { checkIpRateLimit, getClientIP } from "../_shared/rate-limiter.ts";
import {
  confirmationEmailContent,
  createSubscribeBlogHandler,
  type SubscriptionResult,
} from "./handler.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, detectSessionInUrl: false },
});
const turnstileSecret = Deno.env.get("TURNSTILE_SECRET_KEY");
const resendApiKey = Deno.env.get("RESEND_API_KEY");

Deno.serve(createSubscribeBlogHandler({
  getCorsHeaders,
  getClientIP,
  logger: console,
  siteUrl: Deno.env.get("BLOG_SITE_URL"),
  checkIpRate: (ip) => checkIpRateLimit(ip, 5, true),
  async verifyTurnstile(token, ip) {
    if (!turnstileSecret) return "unconfigured";
    const form = new URLSearchParams({
      secret: turnstileSecret,
      response: token,
    });
    if (ip && ip !== "unknown") form.set("remoteip", ip);
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      },
    );
    if (!response.ok) return false;
    const data = await response.json();
    return data?.success === true;
  },
  async requestSubscription(email) {
    const { data, error } = await supabase.rpc("request_blog_subscription", {
      p_email: email,
    });
    if (error || !Array.isArray(data) || data.length !== 1) {
      throw new Error("Subscription RPC failed");
    }
    return data[0] as SubscriptionResult;
  },
  async sendConfirmationEmail(email) {
    if (!resendApiKey) throw new Error("RESEND_API_KEY is required.");
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resendApiKey}`,
      },
      body: JSON.stringify({
        from: "Timer.Coffee Blog <noreply@timer.coffee>",
        to: email.to,
        subject: "Confirm your subscription to the Timer.Coffee Blog",
        ...confirmationEmailContent(email),
      }),
    });
    if (!response.ok) throw new Error("Confirmation email send failed");
  },
}));
