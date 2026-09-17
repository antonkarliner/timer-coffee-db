import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { CandidateInsertPayload } from "./candidate-policy.ts";
import { handleCandidateWebhook } from "./handler.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Missing required Supabase configuration");
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, detectSessionInUrl: false },
});
const resendApiKey = Deno.env.get("RESEND_API_KEY");
const adminEmail = Deno.env.get("ADMIN_EMAIL");
const emailEnabled = Deno.env.get("ROASTER_EMAIL_ENABLED") !== "false";
const telegramBotToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
const telegramChatIds = Deno.env.get("TELEGRAM_CHAT_IDS");
const telegramEnabled = Deno.env.get("TELEGRAM_ENABLED") !== "false";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

async function insertCandidate(payload: CandidateInsertPayload): Promise<void> {
  const { error } = await supabase.schema("service").from(
    "new_roaster_candidates",
  )
    .insert(payload);
  if (error) {
    throw new Error(`Failed to capture roaster candidate: ${error.message}`);
  }
}

async function sendEmail(payload: CandidateInsertPayload): Promise<void> {
  if (!emailEnabled || !resendApiKey || !adminEmail) return;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resendApiKey}`,
    },
    body: JSON.stringify({
      from: "roasters@timer.coffee",
      to: adminEmail,
      subject: `New unreviewed roaster candidate: ${payload.roaster}`,
      html:
        `<p>An unlinked coffee bean created an unreviewed roaster candidate.</p><p><strong>Roaster:</strong> ${
          escapeHtml(payload.roaster)
        }<br><strong>Bean:</strong> ${
          escapeHtml(payload.coffee_bean_name || "N/A")
        }</p><p>No identity match or location has been inferred. Review the cluster enrichment evidence before any canonical action.</p>`,
    }),
  });
  if (!response.ok) {
    throw new Error(`Candidate email failed: ${response.status}`);
  }
}

async function sendTelegram(payload: CandidateInsertPayload): Promise<void> {
  if (!telegramEnabled || !telegramBotToken || !telegramChatIds) return;
  const message = [
    "New unreviewed roaster candidate",
    `Roaster: ${payload.roaster}`,
    `Bean: ${payload.coffee_bean_name || "N/A"}`,
    "No identity match or location has been inferred.",
  ].join("\n");
  for (
    const chatId of telegramChatIds.split(",").map((value) => value.trim())
      .filter(Boolean)
  ) {
    const response = await fetch(
      `https://api.telegram.org/bot${telegramBotToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          disable_web_page_preview: true,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Candidate Telegram alert failed: ${response.status}`);
    }
  }
}

async function notifyCandidate(payload: CandidateInsertPayload): Promise<void> {
  const results = await Promise.allSettled([
    sendEmail(payload),
    sendTelegram(payload),
  ]);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new Error(`${failures.length} candidate notification(s) failed`);
  }
}

Deno.serve(async (request: Request): Promise<Response> => {
  try {
    return await handleCandidateWebhook(request, {
      insertCandidate,
      notifyCandidate,
    });
  } catch (error) {
    console.error("check-new-roaster failed", error);
    return new Response(
      JSON.stringify({ success: false, error: "Candidate capture failed" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
});
