import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { OPENAI_SPECIALIZED_MODELS } from "../_shared/ai-models.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { authorizeServiceRole } from "../_shared/service-role-auth.ts";
import { buildEmbeddingInput, parseRoasterId } from "./request-utils.ts";

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
    detectSessionInUrl: false,
  },
});

interface OpenAiEmbeddingResponse {
  data?: Array<{ embedding?: unknown }>;
}

interface RoasterRecord {
  id: number;
  roaster_name: string | null;
  aliases: string | null;
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  cors: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
    },
  });
}

/**
 * Generate embedding using OpenAI text-embedding-3-small
 * Returns 384-dimensional vector (truncated from 1536)
 */
async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: text,
      model: OPENAI_SPECIALIZED_MODELS.EMBEDDING,
      dimensions: 384,
    }),
  });

  if (!response.ok) {
    console.error("Embedding provider request failed", {
      status: response.status,
    });
    throw new Error("Embedding provider request failed");
  }

  const data = await response.json() as OpenAiEmbeddingResponse;
  const embedding = data.data?.[0]?.embedding;
  if (
    !Array.isArray(embedding) ||
    embedding.length !== 384 ||
    !embedding.every((value) => typeof value === "number")
  ) {
    console.error("Embedding provider returned an invalid payload");
    throw new Error("Embedding provider returned an invalid payload");
  }

  return embedding;
}

serve(async (req) => {
  const origin = req.headers.get("origin") ?? undefined;
  const cors = getCorsHeaders(origin);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: cors,
    });
  }

  // Only allow POST requests
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method Not Allowed" }, 405, cors);
  }

  const authorization = authorizeServiceRole(
    req.headers.get("Authorization"),
    supabaseServiceRoleKey,
  );
  if (!authorization.authorized) {
    return jsonResponse(
      { error: authorization.error },
      authorization.status,
      cors,
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(
      { error: "Request body must be valid JSON." },
      400,
      cors,
    );
  }

  const roasterId = parseRoasterId(
    typeof body === "object" && body !== null && "roaster_id" in body
      ? body.roaster_id
      : undefined,
  );
  if (roasterId === null) {
    return jsonResponse(
      { error: "roaster_id must be a positive integer." },
      400,
      cors,
    );
  }

  try {
    const { data: roasterData, error: lookupError } = await supabase
      .from("coffee_roasters")
      .select("id, roaster_name, aliases")
      .eq("id", roasterId)
      .maybeSingle();

    if (lookupError) {
      console.error("Failed to load roaster for embedding:", lookupError);
      return jsonResponse({ error: "Failed to load roaster." }, 500, cors);
    }
    if (!roasterData) {
      return jsonResponse({ error: "Roaster not found." }, 404, cors);
    }

    const roaster = roasterData as RoasterRecord;
    const textToEmbed = buildEmbeddingInput(
      roaster.roaster_name ?? "",
      roaster.aliases,
    );
    if (!textToEmbed) {
      console.error("Roaster has no canonical name", { roasterId });
      return jsonResponse(
        { error: "Roaster has no canonical name." },
        422,
        cors,
      );
    }

    console.log("Generating canonical roaster embedding", { roasterId });

    // Generate embedding
    const embedding = await generateEmbedding(textToEmbed);

    // Update the roaster record
    const { error } = await supabase.from("coffee_roasters").update({
      name_embedding: embedding,
      embedding_updated_at: new Date().toISOString(),
    }).eq("id", roasterId);

    if (error) {
      console.error("Failed to update roaster embedding:", error);
      return jsonResponse(
        {
          error: "Failed to update roaster embedding",
        },
        500,
        cors,
      );
    }

    console.log("Successfully generated canonical roaster embedding", {
      roasterId,
    });
    return jsonResponse(
      {
        success: true,
        roaster_id: roasterId,
        embedding_dimensions: embedding.length,
      },
      200,
      cors,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error generating embedding:", message);
    return jsonResponse(
      {
        error: "Failed to generate embedding",
      },
      502,
      cors,
    );
  }
});
