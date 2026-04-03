import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { corsHeaders } from "../_shared/cors.ts";
const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const groqApiKey = Deno.env.get('GROQ_API_KEY') ?? '';
if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('Missing Supabase configuration');
}
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
const sleep = (ms)=>new Promise((resolve)=>setTimeout(resolve, ms));
const isRateLimitError = (error)=>{
  if (error instanceof Error && /rate limit/i.test(error.message)) return true;
  try {
    const parsed = typeof error === 'string' ? JSON.parse(error) : null;
    return !!parsed?.error?.code && parsed.error.code === 'rate_limit_exceeded';
  } catch  {
    return false;
  }
};
const isJsonValidationError = (error)=>{
  if (error instanceof Error && /json_validate_failed|Failed to generate JSON/i.test(error.message)) return true;
  try {
    const parsed = typeof error === 'string' ? JSON.parse(error) : null;
    return !!parsed?.error?.code && parsed.error.code === 'json_validate_failed';
  } catch  {
    return false;
  }
};
const parseDurationToMs = (value)=>{
  if (!value) return null;
  // Supports formats like "2.5s" or "2m59.56s"
  const match = value.trim().match(/^(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (!match) return null;
  const minutes = match[1] ? parseFloat(match[1]) : 0;
  const seconds = match[2] ? parseFloat(match[2]) : 0;
  return Math.round((minutes * 60 + seconds) * 1000);
};
const getRetryDelayFromHeaders = (resp, fallbackMs)=>{
  const retryAfterSeconds = resp.headers.get('retry-after');
  if (retryAfterSeconds && !Number.isNaN(Number(retryAfterSeconds))) {
    return Math.max(fallbackMs, Number(retryAfterSeconds) * 1000);
  }
  const resetTokensMs = parseDurationToMs(resp.headers.get('x-ratelimit-reset-tokens'));
  if (resetTokensMs) return Math.max(fallbackMs, resetTokensMs);
  const resetRequestsMs = parseDurationToMs(resp.headers.get('x-ratelimit-reset-requests'));
  if (resetRequestsMs) return Math.max(fallbackMs, resetRequestsMs);
  return fallbackMs;
};
const parseHeaderInt = (value)=>{
  if (!value) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};
const getPostSuccessThrottleMs = (resp)=>{
  const remainingTokens = parseHeaderInt(resp.headers.get('x-ratelimit-remaining-tokens'));
  const remainingRequests = parseHeaderInt(resp.headers.get('x-ratelimit-remaining-requests'));
  const resetTokensMs = parseDurationToMs(resp.headers.get('x-ratelimit-reset-tokens'));
  const resetRequestsMs = parseDurationToMs(resp.headers.get('x-ratelimit-reset-requests'));
  if (remainingTokens !== null && remainingTokens < 500 && resetTokensMs) {
    return resetTokensMs;
  }
  if (remainingRequests !== null && remainingRequests < 5 && resetRequestsMs) {
    return resetRequestsMs;
  }
  return 0;
};
serve(async (req)=>{
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({
      error: "Method Not Allowed"
    }), {
      status: 405,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
  try {
    // SECURITY: Validate user JWT and admin role
    const authHeader = req.headers.get('Authorization') ?? '';
    const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/);
    if (!tokenMatch) {
      return new Response(JSON.stringify({
        error: "Unauthorized - Bearer token required"
      }), {
        status: 401,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    const userJwt = tokenMatch[1];
    // Prefer anon key for least-privilege user-scoped client; fall back to service role if not provided.
    const supabaseUserKey = supabaseAnonKey || supabaseServiceRoleKey;
    const supabaseUser = createClient(supabaseUrl, supabaseUserKey, {
      global: {
        headers: {
          Authorization: `Bearer ${userJwt}`
        }
      }
    });
    const { data: userData, error: userError } = await supabaseUser.auth.getUser(userJwt);
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({
        error: "Unauthorized - Invalid or expired token",
        details: userError?.message
      }), {
        status: 401,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    const userId = userData.user.id;
    const appMetadata = userData.user.app_metadata ?? {};
    const tokenRole = typeof appMetadata.role === 'string' ? appMetadata.role : null;
    let isAdmin = tokenRole === 'admin';
    if (!isAdmin) {
      const adminCheckHeaders = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userJwt}`
      };
      adminCheckHeaders['apikey'] = supabaseAnonKey || supabaseServiceRoleKey;
      const adminCheckResponse = await fetch(`${supabaseUrl}/functions/v1/check-admin-user`, {
        method: 'POST',
        headers: adminCheckHeaders,
        body: JSON.stringify({
          userId
        })
      });
      if (!adminCheckResponse.ok) {
        const adminCheckError = await adminCheckResponse.text();
        console.error("Error calling check-admin-user:", adminCheckError);
        return new Response(JSON.stringify({
          error: "Failed to verify admin role",
          details: adminCheckError
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
          }
        });
      }
      const adminCheckData = await adminCheckResponse.json();
      isAdmin = adminCheckData?.role === 'admin';
    }
    if (!isAdmin) {
      return new Response(JSON.stringify({
        error: "Forbidden - Admin role required"
      }), {
        status: 403,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    const body = await req.json();
    const { partner_name, slug, description, regions, termsandconditions, cta, website_url, image_url, festive_color, promo_code, discount_text, discount_min_percent, discount_max_percent, valid_from, valid_to, priority = 0, is_active, translate = true, target_locales = [] } = body;
    // Validate required fields
    const errors = [];
    const allowedRegions = [
      'EU',
      'NA',
      'AS',
      'AU',
      'AF',
      'ME',
      'SA',
      'WW'
    ];
    if (!partner_name) errors.push({
      field: 'partner_name',
      message: 'Partner name is required'
    });
    if (!valid_from) errors.push({
      field: 'valid_from',
      message: 'Valid from date is required'
    });
    if (!valid_to) errors.push({
      field: 'valid_to',
      message: 'Valid to date is required'
    });
    if (is_active === undefined) errors.push({
      field: 'is_active',
      message: 'Active status is required'
    });
    if (slug !== undefined && (typeof slug !== 'string' || slug.trim().length === 0)) {
      errors.push({
        field: 'slug',
        message: 'Slug must be a non-empty string when provided'
      });
    }
    if (regions !== undefined) {
      if (!Array.isArray(regions)) {
        errors.push({
          field: 'regions',
          message: 'Regions must be an array of strings'
        });
      } else {
        const invalid = regions.filter((r)=>typeof r !== 'string' || !allowedRegions.includes(r));
        if (invalid.length > 0) {
          errors.push({
            field: 'regions',
            message: `Invalid region codes: ${invalid.join(', ')}`
          });
        }
      }
    }
    if (errors.length > 0) {
      return new Response(JSON.stringify({
        success: false,
        errors,
        message: "Validation failed"
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    // Get supported locales from database
    let supportedLocales = [];
    if (translate) {
      const { data: localesData, error: localesError } = await supabaseAdmin.from('supported_locales').select('locale');
      if (localesError) {
        console.error("Error fetching supported locales:", localesError);
        return new Response(JSON.stringify({
          success: false,
          message: "Failed to fetch supported locales",
          error: localesError.message
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
          }
        });
      }
      supportedLocales = localesData.map((l)=>l.locale).filter((l)=>l !== 'en');
      if (target_locales.length > 0) {
        supportedLocales = supportedLocales.filter((l)=>target_locales.includes(l));
      }
    }
    // Generate English content for localizations
    const englishDescription = description && description.trim().length > 0 ? description.trim() : `Exclusive holiday offer from ${partner_name}`;
    const slugToUse = typeof slug === 'string' ? slug.trim() : undefined;
    const regionsToUse = Array.isArray(regions) && regions.length > 0 ? regions : [
      'WW'
    ];
    const englishTermsAndConditions = termsandconditions && termsandconditions.trim().length > 0 ? termsandconditions.trim() : null;
    const englishCta = cta && cta.trim().length > 0 ? cta.trim() : "Visit Partner Website";
    const englishContent = {
      description: englishDescription,
      cta: englishCta,
      discount_text: discount_text || null,
      termsandconditions: englishTermsAndConditions
    };
    // Build localizations object
    const localizations = {
      en: englishContent
    };
    // If translation is disabled, insert with English only
    if (!translate || supportedLocales.length === 0 || !groqApiKey) {
      const { data: giftbox, error: insertError } = await supabaseAdmin.from('giftbox_offers').insert({
        partner_name,
        slug: slugToUse,
        description: englishDescription,
        regions: regionsToUse,
        website_url,
        image_url,
        festive_color,
        promo_code,
        discount_text,
        discount_min_percent,
        discount_max_percent,
        valid_from,
        valid_to,
        priority,
        is_active,
        termsandconditions: englishTermsAndConditions,
        localizations
      }).select().single();
      if (insertError) {
        console.error("Error inserting gift box offer:", insertError);
        return new Response(JSON.stringify({
          success: false,
          message: "Failed to insert gift box offer",
          error: insertError.message
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
          }
        });
      }
      return new Response(JSON.stringify({
        success: true,
        giftbox_id: giftbox.id,
        message: "Gift box offer ingested successfully (English only)",
        translations: []
      }), {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    // Translate to target locales using Groq API
    const translationResults = [];
    const maxTranslationAttempts = 3;
    const baseBackoffMs = 2000;
    const localeThrottleMs = 250;
    for (const locale of supportedLocales){
      console.log(`Translating gift box offer to ${locale}...`);
      // Prepare translation prompt
      const translationPrompt = `
Translate the following gift box offer content from English to ${locale}. Maintain the promotional tone and keep business names exactly as provided (do NOT translate partner names or brand names). Every field in the output must correspond to the same labeled field from the input—never move text between fields.

Original Content:
Partner Name (do not translate): ${partner_name}
Description: ${englishContent.description}
CTA: ${englishContent.cta}
${englishContent.discount_text ? `Discount Text (promo copy): ${englishContent.discount_text}` : 'Discount Text (promo copy): (none provided, return null)'}
${englishTermsAndConditions ? `Terms & Conditions (legal/promo rules): ${englishTermsAndConditions}` : 'Terms & Conditions (legal/promo rules): (none provided, return null)'}

Return the translation in EXACTLY this JSON shape with only these keys:
{
  "description": "translated description",
  "cta": "translated cta",
  "discount_text": "translated discount text or null",
  "termsandconditions": "translated terms and conditions text or null"
}

Rules (strict):
- Copy business/brand names verbatim.
- Do NOT include validity dates anywhere; dates are handled separately.
- \`termsandconditions\` is ONLY the promo code / legal / exclusions text.
- \`discount_text\` must stay a short promo/discount line; do not place terms or legal text here.
- If a source field is null/empty, return null for that field; do not invent content.
- Output must be valid JSON (no trailing commas) and include every key above.`;
      let parsedTranslation = null;
      let lastError = null;
      for(let attempt = 0; attempt < maxTranslationAttempts; attempt++){
        try {
          // Use Groq API for translation
          const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${groqApiKey}`
            },
            body: JSON.stringify({
              model: 'openai/gpt-oss-120b',
              messages: [
                {
                  role: 'system',
                  content: 'You are a professional translator for a coffee brewing timer app. Preserve all business/brand names unchanged. Provide translations in the exact JSON format requested and keep each field mapped to its corresponding label.'
                },
                {
                  role: 'user',
                  content: translationPrompt
                }
              ],
              temperature: 0.3,
              max_tokens: 1800,
              response_format: {
                type: "json_object"
              }
            })
          });
          if (!groqResponse.ok) {
            const errorText = await groqResponse.text();
            lastError = new Error(`Groq API error: ${errorText}`);
            if (groqResponse.status === 429 || isRateLimitError(errorText) || isJsonValidationError(errorText)) {
              const delayMs = getRetryDelayFromHeaders(groqResponse, baseBackoffMs * Math.pow(2, attempt));
              console.warn(`Groq retry on ${locale} (status ${groqResponse.status}) attempt ${attempt + 1}. Reason: ${errorText}. Waiting ${delayMs}ms`);
              await sleep(delayMs);
              continue;
            }
            throw lastError;
          }
          const groqData = await groqResponse.json();
          const translationContent = groqData.choices[0]?.message?.content?.trim();
          if (!translationContent) {
            throw new Error('Empty translation response from Groq');
          }
          const throttleMs = getPostSuccessThrottleMs(groqResponse);
          if (throttleMs > 0) {
            console.warn(`Groq post-success throttle on ${locale}: waiting ${throttleMs}ms based on rate limit headers`);
            await sleep(throttleMs);
          }
          // Parse the JSON translation
          const rawTranslation = JSON.parse(translationContent);
          const normalizedTranslation = {
            description: typeof rawTranslation.description === 'string' ? rawTranslation.description.trim() : '',
            cta: typeof rawTranslation.cta === 'string' ? rawTranslation.cta.trim() : '',
            discount_text: rawTranslation.discount_text === null || rawTranslation.discount_text === undefined ? null : String(rawTranslation.discount_text).trim(),
            termsandconditions: rawTranslation.termsandconditions === null || rawTranslation.termsandconditions === undefined ? null : String(rawTranslation.termsandconditions).trim()
          };
          const hasValue = (value)=>typeof value === 'string' && value.trim().length > 0;
          if (!hasValue(normalizedTranslation.description) || !hasValue(normalizedTranslation.cta)) {
            throw new Error('Translation missing required text fields');
          }
          if (englishContent.discount_text && !hasValue(normalizedTranslation.discount_text)) {
            throw new Error('Translation missing discount_text while source provided one');
          }
          if (!englishContent.discount_text) {
            normalizedTranslation.discount_text = null;
          }
          if (englishTermsAndConditions && !hasValue(normalizedTranslation.termsandconditions)) {
            throw new Error('Translation missing termsandconditions while source provided them');
          }
          if (!englishTermsAndConditions) {
            normalizedTranslation.termsandconditions = null;
          }
          parsedTranslation = normalizedTranslation;
          break; // success
        } catch (error) {
          lastError = error;
          const shouldRetry = (isRateLimitError(error) || isJsonValidationError(error)) && attempt < maxTranslationAttempts - 1;
          if (shouldRetry) {
            const delayMs = baseBackoffMs * Math.pow(2, attempt);
            console.warn(`Rate limited on ${locale}, attempt ${attempt + 1}. Retrying in ${delayMs}ms`);
            await sleep(delayMs);
            continue;
          }
          break;
        }
      }
      if (parsedTranslation) {
        localizations[locale] = parsedTranslation;
        translationResults.push({
          locale,
          content: parsedTranslation,
          success: true
        });
      } else {
        console.error(`Error translating to ${locale}:`, lastError);
        translationResults.push({
          locale,
          content: {
            description: '',
            cta: '',
            discount_text: null,
            termsandconditions: null
          },
          success: false,
          error: lastError instanceof Error ? lastError.message : "Unknown translation error"
        });
      }
      if (localeThrottleMs > 0) {
        await sleep(localeThrottleMs);
      }
    }
    // Insert the complete gift box offer with all translations
    const { data: giftbox, error: insertError } = await supabaseAdmin.from('giftbox_offers').insert({
      partner_name,
      slug: slugToUse,
      description: englishDescription,
      regions: regionsToUse,
      website_url,
      image_url,
      festive_color,
      promo_code,
      discount_text,
      discount_min_percent,
      discount_max_percent,
      valid_from,
      valid_to,
      priority,
      is_active,
      termsandconditions: englishTermsAndConditions,
      localizations
    }).select().single();
    if (insertError) {
      console.error("Error inserting gift box offer:", insertError);
      return new Response(JSON.stringify({
        success: false,
        message: "Failed to insert gift box offer",
        error: insertError.message,
        translations: translationResults
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    // Prepare response
    const successfulTranslations = translationResults.filter((r)=>r.success);
    const failedTranslations = translationResults.filter((r)=>!r.success);
    return new Response(JSON.stringify({
      success: true,
      giftbox_id: giftbox.id,
      translations: successfulTranslations,
      translation_errors: failedTranslations.length > 0 ? failedTranslations : undefined,
      message: `Gift box offer ingested successfully with ${successfulTranslations.length} translations`,
      total_locales_attempted: supportedLocales.length,
      successful_translations: successfulTranslations.length,
      failed_translations: failedTranslations.length
    }), {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    console.error("Unexpected error in gift box ingest:", error);
    return new Response(JSON.stringify({
      error: "Internal Server Error",
      message: error instanceof Error ? error.message : "Unknown error"
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
});
