import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";

// This function has been retired. It was the OneSignal-era translation handler,
// called by the translate_notification_after_insert trigger on public.notifications.
// That entire pipeline has been replaced by the FCM system:
//   notification-api / send-fcm-notification → service.notifications
// The replacement is translate-and-send-fcm-notification.
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  return new Response(
    JSON.stringify({
      success: false,
      error: "This function has been retired. The FCM pipeline no longer uses this handler.",
      code: "FUNCTION_RETIRED",
    }),
    {
      status: 410,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
