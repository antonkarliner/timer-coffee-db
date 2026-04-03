import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false
  }
});
const json = (body, status = 200)=>new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
serve(async (req)=>{
  if (req.method !== "POST") return json({
    error: "Method not allowed"
  }, 405);
  let body;
  try {
    body = await req.json();
  } catch  {
    return json({
      error: "Invalid JSON"
    }, 400);
  }
  const { content, locale, publication_time } = body;
  if (!content || !locale || !publication_time) {
    return json({
      error: "Missing required fields"
    }, 400);
  }
  const runAt = new Date(publication_time);
  if (isNaN(runAt.valueOf())) return json({
    error: "Invalid publication_time"
  }, 400);
  console.log("Scheduling popup for:", runAt.toISOString());
  const { data, error } = await supabase.rpc("enqueue_popup", {
    _content: content,
    _locale: locale,
    _run_at: runAt.toISOString()
  });
  if (error) {
    console.error("Error from enqueue_popup:", error);
    return json({
      error: error.message,
      details: error.details
    }, 500);
  }
  return json({
    success: true,
    msg_id: data
  });
});
