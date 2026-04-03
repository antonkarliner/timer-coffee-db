import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const openaiApiKey = Deno.env.get("OPENAI_API_KEY");
if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("Missing required Supabase configuration");
}
if (!openaiApiKey) {
  throw new Error("Missing required OPENAI_API_KEY");
}
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    detectSessionInUrl: false
  }
});
/**
 * Generate embedding using OpenAI text-embedding-3-small
 * Returns 384-dimensional vector (truncated from 1536)
 */ async function generateEmbedding(text) {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      input: text,
      model: "text-embedding-3-small",
      dimensions: 384
    })
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Embedding generation failed: ${response.status} ${errorBody}`);
  }
  const data = await response.json();
  return data.data[0].embedding;
}
serve(async (req)=>{
  const origin = req.headers.get("origin") ?? undefined;
  const cors = getCorsHeaders(origin);
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: cors
    });
  }
  // Only allow POST requests
  if (req.method !== "POST") {
    return new Response(JSON.stringify({
      error: "Method Not Allowed"
    }), {
      status: 405,
      headers: {
        ...cors,
        "Content-Type": "application/json"
      }
    });
  }
  try {
    const body = await req.json();
    const { roaster_id, roaster_name, aliases } = body;
    // Validate inputs
    if (!roaster_id || !roaster_name) {
      return new Response(JSON.stringify({
        error: "Missing required fields: roaster_id and roaster_name"
      }), {
        status: 400,
        headers: {
          ...cors,
          "Content-Type": "application/json"
        }
      });
    }
    // Combine roaster name with aliases for richer embedding
    const textToEmbed = aliases && aliases.trim() !== "" ? `${roaster_name} ${aliases.replace(/,/g, " ")}` : roaster_name;
    console.log(`Generating embedding for roaster ${roaster_id}: "${textToEmbed}"`);
    // Generate embedding
    const embedding = await generateEmbedding(textToEmbed);
    // Update the roaster record
    const { error } = await supabase.from("coffee_roasters").update({
      name_embedding: embedding,
      embedding_updated_at: new Date().toISOString()
    }).eq("id", roaster_id);
    if (error) {
      console.error("Failed to update roaster embedding:", error);
      return new Response(JSON.stringify({
        error: "Failed to update roaster embedding",
        details: error.message
      }), {
        status: 500,
        headers: {
          ...cors,
          "Content-Type": "application/json"
        }
      });
    }
    console.log(`Successfully generated embedding for roaster ${roaster_id}`);
    return new Response(JSON.stringify({
      success: true,
      roaster_id,
      embedding_dimensions: embedding.length
    }), {
      headers: {
        ...cors,
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error generating embedding:", message);
    return new Response(JSON.stringify({
      error: "Failed to generate embedding",
      details: message
    }), {
      status: 500,
      headers: {
        ...cors,
        "Content-Type": "application/json"
      }
    });
  }
});
