import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import OpenAI from "https://deno.land/x/openai@v4.38.3/mod.ts";
import { corsHeaders } from "../_shared/cors.ts";

interface TranslationRequest {
  title: string;
  content: string;
  locales: string[];
  platform: string;
  deep_link?: string;
  scheduled_at?: string;
  notification_group_id?: string;
}

interface TranslationResult {
  locale: string;
  title: string;
  content: string;
  id: number;
  error?: string;
}

interface TranslationError {
  locale: string;
  error: string;
}

type TranslationResponse = TranslationResult | TranslationError;

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const openaiApiKey = Deno.env.get('OPENAI_API_KEY_NON_PERSONAL') ?? '';

serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // SECURITY: Validate this is a system call from database trigger
    const systemCallHeader = req.headers.get('x-system-call');
    if (systemCallHeader !== 'database-trigger') {
      console.warn(`Unauthorized access attempt to translate-and-send-notification from ${req.headers.get('user-agent') || 'unknown'}`);
      return new Response(JSON.stringify({
        error: "Unauthorized - This function is for system use only",
        code: "SYSTEM_ONLY_FUNCTION"
      }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body: TranslationRequest = await req.json();
    const {
      title,
      content,
      locales,
      platform,
      deep_link,
      scheduled_at,
      notification_group_id
    } = body;

    // Validate required fields
    if (!title || !content || !locales || !platform) {
      return new Response(JSON.stringify({
        error: "Missing required fields: title, content, locales, platform"
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate OpenAI configuration
    if (!openaiApiKey) {
      return new Response(JSON.stringify({ 
        error: "OpenAI API key is not configured" 
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
    const openai = new OpenAI({ apiKey: openaiApiKey });

    if (!locales || locales.length === 0) {
      return new Response(JSON.stringify({
        error: "No target locales provided for translation"
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Translate to each locale - matching the working translate-openai pattern
    console.log("Starting translation for locales:", locales);
    console.log("Original title:", title);
    console.log("Original content:", content);
    
    const translationPromises = locales.map(async (locale: string) => {
      try {
        console.log(`Translating to ${locale}...`);
        
        // Translate title first
        const titleCompletion = await openai.chat.completions.create({
          messages: [
            {
              role: "system",
              content: `Translate this text into ${locale} focusing on accuracy and context. This is a title for a coffee brewing timer app, translate all the terms correctly.`
            },
            { role: "user", content: title }
          ],
          model: 'gpt-4.1-mini',
        });

        const translatedTitle = titleCompletion.choices[0]?.message?.content?.trim();
        if (!translatedTitle) {
          throw new Error(`Empty title translation for locale ${locale}`);
        }

        // Translate content
        const contentCompletion = await openai.chat.completions.create({
          messages: [
            {
              role: "system",
              content: `Translate this text into ${locale} focusing on accuracy and context. This is content for a coffee brewing timer app, translate all the terms correctly.`
            },
            { role: "user", content: content }
          ],
          model: 'gpt-4.1-mini',
        });

        const translatedContent = contentCompletion.choices[0]?.message?.content?.trim();
        if (!translatedContent) {
          throw new Error(`Empty content translation for locale ${locale}`);
        }

        console.log(`Translation for ${locale} - Title: ${translatedTitle}, Content: ${translatedContent}`);

        // Insert translated notification
        const { data: inserted, error: insertError } = await supabase
          .from('notifications')
          .insert({
            title: translatedTitle,
            content: translatedContent,
            locale,
            platform,
            deep_link: deep_link,
            scheduled_at: scheduled_at,
            notification_group_id: notification_group_id,
            is_translated: true,
          })
          .select()
          .single();

        if (insertError) {
          console.error(`Error inserting translation for ${locale}:`, insertError);
          throw insertError;
        }

        console.log(`Successfully inserted translation for ${locale} with ID: ${inserted.id}`);
        return { locale, title: translatedTitle, content: translatedContent, id: inserted.id };
      } catch (error) {
        console.error(`Error translating to ${locale}:`, error);
        return { locale, error: error instanceof Error ? error.message : "Unknown error" };
      }
    });

    const translations = await Promise.all(translationPromises);

    const successfulTranslations: TranslationResult[] = [];

    translations.forEach((translation: TranslationResponse) => {
      if ('error' in translation) {
        return;
      }
      successfulTranslations.push({
        locale: translation.locale,
        title: translation.title,
        content: translation.content,
        id: translation.id
      });
    });

    return new Response(JSON.stringify({
      success: true,
      translations: successfulTranslations,
      errors: translations
        .filter((t: TranslationResponse) => 'error' in t)
        .map((t: TranslationResponse) => ({
          locale: t.locale,
          error: (t as TranslationError).error
        })),
      message: scheduled_at
        ? "Translations created successfully. Notifications will be sent by cron job at scheduled time."
        : "Translations created successfully.",
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("Unexpected error:", error);
    return new Response(JSON.stringify({ 
      error: "Internal Server Error",
      message: error instanceof Error ? error.message : "Unknown error" 
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});