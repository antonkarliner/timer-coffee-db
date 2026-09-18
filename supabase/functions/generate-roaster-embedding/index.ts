import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { OPENAI_SPECIALIZED_MODELS } from "../_shared/ai-models.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import {
  DbError,
  EmbeddingInputError,
} from "../_shared/roaster-postprocess-errors.ts";
import {
  generateRoasterNameEmbedding,
} from "../_shared/roaster-embedding-core.ts";
import { authorizeServiceRole } from "../_shared/service-role-auth.ts";
import { parseRoasterId } from "./request-utils.ts";

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

    console.log("Generating canonical roaster embedding", { roasterId });

    // Generate the embedding and persist it — the ONE implementation in
    // _shared/roaster-embedding-core.ts (same vector space as every stored
    // vector: OPENAI_SPECIALIZED_MODELS.EMBEDDING at dimensions 384 via
    // OPENAI_API_KEY).
    const { embedding } = await generateRoasterNameEmbedding({
      openAiApiKey: openaiApiKey,
      model: OPENAI_SPECIALIZED_MODELS.EMBEDDING,
      fetchImpl: fetch,
      updateRoasterEmbedding: async (id, vector) => {
        const { error } = await supabase.from("coffee_roasters").update({
          name_embedding: vector,
          embedding_updated_at: new Date().toISOString(),
        }).eq("id", id);
        if (error) {
          throw new DbError(
            `Failed to update roaster embedding: ${error.message}`,
          );
        }
      },
    }, {
      roasterId,
      roasterName: roaster.roaster_name,
      aliases: roaster.aliases,
    });

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
    if (error instanceof EmbeddingInputError) {
      console.error("Roaster has no canonical name", { roasterId });
      return jsonResponse(
        { error: "Roaster has no canonical name." },
        422,
        cors,
      );
    }
    if (error instanceof DbError) {
      console.error("Failed to update roaster embedding:", error.message);
      return jsonResponse(
        {
          error: "Failed to update roaster embedding",
        },
        500,
        cors,
      );
    }
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
