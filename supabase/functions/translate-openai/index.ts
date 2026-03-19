import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import OpenAI from "https://esm.sh/openai";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";

// Fetching environment variables
const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error("Supabase URL or Service Role Key is not set in environment variables.");
  Deno.exit(1);
}

// Create a Supabase client using the service role key for full access
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

serve(async (req) => {
  const requestOrigin = req.headers.get("origin");
  const cors = getCorsHeaders(requestOrigin || undefined);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: cors });
  }

  const body = await req.json();
  const { text, locales, platform } = body;

  // Configure OpenAI client
  const apiKey = Deno.env.get('OPENAI_API_KEY_NON_PERSONAL') ?? '';
  if (!apiKey) {
    console.error("OpenAI API key is not set in environment variables.");
    return new Response("Internal Server Error", { status: 500, headers: cors });
  }
  const client = new OpenAI({ apiKey });

  const results = await Promise.all(locales.map(async (locale: string) => {
    try {
      const chatCompletion = await client.chat.completions.create({
        messages: [
          { role: "system", content: `Translate this text into ${locale} focusing on accuracy and context. This is a line to use in coffee brewing timer app, translate all the terms correctly.` },
          { role: "user", content: text }
        ],
        model: 'gpt-5.4'
      });

      // Insert translated content into the database, setting is_translated to true
      const { data, error } = await supabase
        .from('launch_popup')
        .insert([
          { content: chatCompletion.choices[0].message.content, locale: locale, is_translated: true, ...(platform !== undefined && { platform }) }
        ]);

      if (error) throw error;

      return data;
    } catch (error) {
      console.error('Error:', error);
      return { error: error instanceof Error ? error.message : String(error), locale };
    }
  }));

  return new Response(JSON.stringify(results), { headers: { ...cors, 'Content-Type': 'application/json' } });
});
