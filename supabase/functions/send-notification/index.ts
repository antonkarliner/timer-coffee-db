import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";

// This function has been retired. The OneSignal-based notification pipeline
// (public.notifications → translate_notification_after_insert trigger →
//  translate-and-send-notification) was replaced in November 2025 by the
// FCM pipeline: notification-api / send-fcm-notification → service.notifications.
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  return new Response(
    JSON.stringify({
      success: false,
      error: "This function has been retired. Use notification-api or send-fcm-notification instead.",
      code: "FUNCTION_RETIRED",
    }),
    {
      status: 410,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
