import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import OpenAI from "https://esm.sh/openai"; // latest
import { corsHeaders } from "../_shared/cors.ts";

interface FCMTranslationRequest {
  title: string;
  body: string;
  data?: Record<string, string | number | boolean>;
  locales: string[];
  userId?: string;
  templateId?: string;
  priority?: "low" | "normal" | "high";
  category?: string;
  scheduled_at?: string;
  deep_link?: string;
}

interface FCMTranslationResult {
  locale: string;
  title: string;
  body: string;
  id?: number;
  error?: string;
}

interface FCMTranslationError {
  locale: string;
  error: string;
}

type FCMTranslationResponse = FCMTranslationResult | FCMTranslationError;

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const openaiApiKey = Deno.env.get('OPENAI_API_KEY_NON_PERSONAL') ?? '';
const fcmServerKey = Deno.env.get('FCM_SERVER_KEY') ?? '';

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
      console.warn(`Unauthorized access attempt to translate-and-send-fcm-notification from ${req.headers.get('user-agent') || 'unknown'}`);
      return new Response(JSON.stringify({
        error: "Unauthorized - This function is for system use only",
        code: "SYSTEM_ONLY_FUNCTION"
      }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body: FCMTranslationRequest = await req.json();
    const {
      title,
      body: notificationBody,
      data = {},
      locales,
      userId,
      templateId,
      priority = "normal",
      category = "general",
      scheduled_at,
      deep_link
    } = body;
    const linkSummary = {
      deep_link,
      external_url: (data as Record<string, unknown> | undefined)?.["external_url"] ?? null,
      open_in_browser: (data as Record<string, unknown> | undefined)?.["open_in_browser"] ?? null,
      linkKeys: data ? Object.keys(data).filter(key => key.toLowerCase().includes("link")) : [],
    };
    console.log("FCM translation request metadata", {
      userId,
      templateId,
      locales,
      scheduled_at,
      priority,
      category,
      linkSummary,
    });

    // Validate required fields
    if (!title || !notificationBody || !locales) {
      return new Response(JSON.stringify({
        error: "Missing required fields: title, body, locales"
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

    // Validate FCM configuration
    if (!fcmServerKey) {
      console.error("FCM server key is not configured");
      // Don't fail the request, but log the error
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

    // Determine platform for immediate notifications
    let platform = 'all'; // Default for scheduled notifications
    if (!scheduled_at && userId) {
      try {
        const { data: userTokens, error: tokenError } = await supabase
          .from('user_fcm_tokens')
          .select('device_type')
          .eq('user_id', userId)
          .eq('is_active', true)
          .limit(1);

        if (!tokenError && userTokens && userTokens.length > 0) {
          platform = userTokens[0].device_type; // ios, android, or web
        }
      } catch (error) {
        console.error('Error determining platform from device_type:', error);
      }
    }
    
    // Translate to each locale - matching OneSignal translation pattern
    console.log("Starting FCM translation for locales:", locales);
    console.log("Original title:", title);
    console.log("Original body:", notificationBody);
    console.log("Platform:", platform);
    console.log(`Processing FCM translation for user ${userId} with deep_link: ${deep_link}`);
    
    const translationPromises = locales.map(async (locale: string) => {
      try {
        console.log(`Translating FCM notification to ${locale}...`);
        
        // Translate title first
        const titleCompletion = await openai.chat.completions.create({
          messages: [
            {
              role: "system",
              content: `Translate this text into ${locale} focusing on accuracy and context. This is a title for a coffee brewing timer app, translate all terms correctly.`
            },
            { role: "user", content: title }
          ],
          model: 'gpt-5.2'
        });

        const translatedTitle = titleCompletion.choices[0]?.message?.content?.trim();
        if (!translatedTitle) {
          throw new Error(`Empty title translation for locale ${locale}`);
        }

        // Translate body
        const bodyCompletion = await openai.chat.completions.create({
          messages: [
            {
              role: "system",
              content: `Translate this text into ${locale} focusing on accuracy and context. This is content for a coffee brewing timer app, translate all terms correctly.`
            },
            { role: "user", content: notificationBody }
          ],
          model: 'gpt-5.2',
        });

        const translatedBody = bodyCompletion.choices[0]?.message?.content?.trim();
        if (!translatedBody) {
          throw new Error(`Empty body translation for locale ${locale}`);
        }

        console.log(`FCM translation for ${locale} - Title: ${translatedTitle}, Body: ${translatedBody}`);

        // Insert translated FCM notification
        const { data: inserted, error: insertError } = await supabase
          .from('notifications')
          .insert({
            title: translatedTitle,
            body: translatedBody,
            data: data,
            locale,
            platform: platform,
            user_id: userId,
            template_id: templateId,
            priority,
            category,
            scheduled_at: scheduled_at,
            is_translated: true,
            status: scheduled_at ? 'scheduled' : 'pending'
          })
          .select()
          .single();

        if (insertError) {
          console.error(`Error inserting FCM translation for ${locale}:`, insertError);
          throw insertError;
        }

        console.log(`Successfully inserted FCM translation for ${locale} with ID: ${inserted.id}`);
        return { locale, title: translatedTitle, body: translatedBody, id: inserted.id };
      } catch (error) {
        console.error(`Error translating FCM notification to ${locale}:`, error);
        return { locale, error: error instanceof Error ? error.message : "Unknown error" };
      }
    });

    const translations = await Promise.all(translationPromises);

    const successfulTranslations: FCMTranslationResult[] = [];
    
    translations.forEach((translation: FCMTranslationResponse) => {
      if ('error' in translation) {
        // This is an error response
        return;
      }
      
      // This is a successful translation
      successfulTranslations.push({
        locale: translation.locale,
        title: translation.title,
        body: translation.body,
        id: translation.id
      });
    });

    // Send immediately if no scheduled_at is provided and we have userId
    let notificationsSent = false;
    let message = "FCM translations created successfully. Notifications will be sent by cron job at scheduled time.";
    
    if (!scheduled_at && userId && successfulTranslations.length > 0) {
      try {
        // Get user's FCM tokens for their preferred locales
        const { data: userTokens, error: tokenError } = await supabase
          .from('user_fcm_tokens')
          .select('token, device_type, locale, is_active')
          .eq('user_id', userId)
          .eq('is_active', true);

        if (tokenError) {
          console.error("Error fetching user FCM tokens:", tokenError);
          throw tokenError;
        }

        if (!userTokens || userTokens.length === 0) {
          console.log(`No active FCM tokens found for user ${userId}`);
          message = "FCM translations created but no active tokens found for user.";
        } else {
          // Group tokens by locale for targeted sending
          const tokensByLocale = userTokens.reduce((acc, token) => {
            const tokenLocale = token.locale || 'en';
            if (!acc[tokenLocale]) {
              acc[tokenLocale] = [];
            }
            acc[tokenLocale].push(token.token);
            return acc;
          }, {} as Record<string, string[]>);

          // Send FCM notifications for each locale where we have both translation and tokens
      const fcmPromises = successfulTranslations.map(async (translation) => {
        const tokensForLocale = tokensByLocale[translation.locale] || tokensByLocale['en'] || [];
        
        if (tokensForLocale.length === 0) {
          console.log(`No tokens found for locale ${translation.locale}`);
          return { locale: translation.locale, sent: false, reason: "No tokens" };
        }

        try {
          console.log("Sending translated FCM notification", {
            locale: translation.locale,
            tokenCount: tokensForLocale.length,
            deep_link: deep_link ?? linkSummary.deep_link,
            external_url: linkSummary.external_url,
            open_in_browser: linkSummary.open_in_browser,
          });

          const fcmResponse = await fetch(`${supabaseUrl}/functions/v1/send-fcm-notification`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${supabaseServiceRoleKey}`
                },
                body: JSON.stringify({
                  tokens: tokensForLocale,
                  title: translation.title,
                  body: translation.body,
                  data: data,
                  priority,
                  notificationId: translation.id,
                  deep_link: deep_link
                })
              });

              if (!fcmResponse.ok) {
                const errorText = await fcmResponse.text();
                console.error(`FCM send failed for ${translation.locale}:`, errorText);
                return { locale: translation.locale, sent: false, error: errorText };
              }

              const fcmResult = await fcmResponse.json();
              console.log(`FCM notification sent successfully for ${translation.locale}:`, fcmResult);
              return { locale: translation.locale, sent: true, result: fcmResult };
            } catch (error) {
              console.error(`Error sending FCM for ${translation.locale}:`, error);
              return { locale: translation.locale, sent: false, error: error instanceof Error ? error.message : "Unknown error" };
            }
          });

          const fcmResults = await Promise.all(fcmPromises);
          const anySent = fcmResults.some(result => result.sent);
          
          if (anySent) {
            // Mark successful translations as sent
            const translationIds = successfulTranslations
              .filter(t => fcmResults.some(r => r.locale === t.locale && r.sent))
              .map(t => t.id)
              .filter(Boolean);

            if (translationIds.length > 0) {
              await supabase
                .from('notifications')
                .update({ status: 'sent', sent_at: new Date().toISOString() })
                .in('id', translationIds);
            }
            
            notificationsSent = true;
            message = "FCM translations created and notifications sent immediately.";
          } else {
            message = "FCM translations created but failed to send notifications.";
          }
        }
      } catch (error) {
        console.error("Error sending immediate FCM notifications:", error);
        message = "FCM translations created but failed to send notifications immediately.";
      }
    }

    return new Response(JSON.stringify({
      success: true,
      translations: successfulTranslations,
      errors: translations
        .filter((t: FCMTranslationResponse) => 'error' in t)
        .map((t: FCMTranslationResponse) => ({
          locale: t.locale,
          error: (t as FCMTranslationError).error
        })),
      notificationsSent,
      fcmConfigured: !!fcmServerKey,
      message,
      immediateSend: !scheduled_at && !!userId
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("Unexpected error in FCM translation:", error);
    return new Response(JSON.stringify({ 
      error: "Internal Server Error",
      message: error instanceof Error ? error.message : "Unknown error" 
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
})
