import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";
serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  return new Response(JSON.stringify({
    success: false,
    error: "This function has been retired. Scheduled notifications are no longer supported via OneSignal.",
    code: "FUNCTION_RETIRED"
  }), {
    status: 410,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
});
