import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import OpenAI from "https://esm.sh/openai";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
import {
  connectedAppForbiddenResponse,
  isConnectedAppToken,
} from "../_shared/connected-app.ts";
import { OPENAI_MODELS } from "../_shared/ai-models.ts";
import { baseLang } from "./locale-utils.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const openaiApiKey = Deno.env.get("OPENAI_API_KEY_NON_PERSONAL") ?? "";

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}
if (!openaiApiKey) {
  throw new Error("OPENAI_API_KEY_NON_PERSONAL is required.");
}

const MODEL = OPENAI_MODELS.MEDIUM;

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false, detectSessionInUrl: false },
});

const openai = new OpenAI({ apiKey: openaiApiKey });

interface ReviewRow {
  id: string;
  user_id: string;
  is_public: boolean;
  bean_name: string | null;
  review_text: string | null;
  detected_source_locale: string | null;
}

interface CacheRow {
  source_locale: string;
  translated_text: string;
  translated_bean_name: string | null;
  model: string;
}

type Outcome =
  | {
      status: "translated";
      translated_text: string;
      translated_bean_name: string | null;
      source_locale: string;
      model: string;
    }
  | {
      status: "cached";
      translated_text: string;
      translated_bean_name: string | null;
      source_locale: string;
      model: string;
    }
  | { status: "same_language"; source_locale: string }
  | { status: "empty" }
  | { status: "forbidden" }
  | { status: "not_found" }
  | { status: "error"; error: string };

async function translateOne(
  reviewId: string,
  targetLocale: string,
  callerUserId: string | null,
): Promise<Outcome> {
  const { data: review, error: reviewErr } = await supabase
    .from("bean_reviews")
    .select("id, user_id, is_public, bean_name, review_text, detected_source_locale")
    .eq("id", reviewId)
    .maybeSingle<ReviewRow>();

  if (reviewErr) {
    return { status: "error", error: reviewErr.message };
  }
  if (!review) {
    return { status: "not_found" };
  }
  if (!review.is_public && review.user_id !== callerUserId) {
    return { status: "forbidden" };
  }
  const text = review.review_text?.trim() ?? "";
  const name = review.bean_name?.trim() ?? "";
  // Nothing translatable at all.
  if (!text && !name) {
    return { status: "empty" };
  }

  // Cache hit?
  const { data: cached } = await supabase
    .from("bean_review_translations")
    .select("source_locale, translated_text, translated_bean_name, model")
    .eq("review_id", reviewId)
    .eq("target_locale", targetLocale)
    .maybeSingle<CacheRow>();

  if (cached) {
    return {
      status: "cached",
      translated_text: cached.translated_text,
      translated_bean_name: cached.translated_bean_name,
      source_locale: cached.source_locale,
      model: cached.model,
    };
  }

  // Same-language short-circuit (avoid OpenAI call when we already know the
  // source). Detection is driven by the review text; only short-circuit when
  // there is text to have detected from.
  if (
    text &&
    review.detected_source_locale &&
    baseLang(review.detected_source_locale) === baseLang(targetLocale)
  ) {
    return { status: "same_language", source_locale: review.detected_source_locale };
  }

  const systemPrompt =
    `You translate coffee tasting reviews into the target language "${targetLocale}" (BCP-47). ` +
    `The user message is JSON {"review":<string>,"bean_name":<string>} (either may be empty). ` +
    `Detect the source language of the review text (or the bean name if the review is empty) ` +
    `as a BCP-47 code. ` +
    `Return the base language subtag only (e.g. "en", not "en-US"). Treat regional ` +
    `variants as the same language: if the source and "${targetLocale}" share the same ` +
    `base language, respond with {"lang":"<detected-source>","same":true}. ` +
    `If the detected source language equals "${targetLocale}", respond with ` +
    `JSON {"lang":"<detected-source>","same":true} and do not translate. ` +
    `Otherwise respond with JSON {"lang":"<detected-source>",` +
    `"translation":"<review translated into ${targetLocale}, empty string if review is empty>",` +
    `"bean_name":"<bean name rendered in ${targetLocale}; transliterate proper names rather ` +
    `than forcing a literal translation; empty string if bean_name is empty>"}. ` +
    `Translations MUST be written in "${targetLocale}". ` +
    `Preserve coffee-tasting vocabulary; do not embellish or add disclaimers.`;

  let parsed: { lang?: string; same?: boolean; translation?: string; bean_name?: string };
  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      reasoning_effort: "none",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify({ review: text, bean_name: name }) },
      ],
    });
    const content = completion.choices[0]?.message?.content ?? "{}";
    parsed = JSON.parse(content);
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const sourceLocale = (parsed.lang ?? "").trim();
  if (!sourceLocale) {
    return { status: "error", error: "OpenAI returned no source language." };
  }

  if (parsed.same === true || baseLang(sourceLocale) === baseLang(targetLocale)) {
    if (text) {
      await supabase
        .from("bean_reviews")
        .update({ detected_source_locale: sourceLocale })
        .eq("id", reviewId);
    }
    return { status: "same_language", source_locale: sourceLocale };
  }

  const translation = (parsed.translation ?? "").trim();
  const translatedName = (parsed.bean_name ?? "").trim() || null;
  // We must produce something useful for whichever fields were present.
  if (text && !translation) {
    return { status: "error", error: "OpenAI returned no translation." };
  }
  if (name && !translatedName) {
    return { status: "error", error: "OpenAI returned no bean name translation." };
  }

  const { error: upsertErr } = await supabase
    .from("bean_review_translations")
    .upsert({
      review_id: reviewId,
      target_locale: targetLocale,
      source_locale: sourceLocale,
      translated_text: translation,
      translated_bean_name: translatedName,
      model: MODEL,
    });
  if (upsertErr) {
    return { status: "error", error: upsertErr.message };
  }

  if (text) {
    await supabase
      .from("bean_reviews")
      .update({ detected_source_locale: sourceLocale })
      .eq("id", reviewId);
  }

  return {
    status: "translated",
    translated_text: translation,
    translated_bean_name: translatedName,
    source_locale: sourceLocale,
    model: MODEL,
  };
}

serve(async (req) => {
  const cors = getCorsHeaders(req.headers.get("origin") ?? undefined);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: cors });
  }

  // Resolve caller identity from the Authorization header when present.
  // Anonymous callers (no/invalid token, or anon-key) are allowed to translate
  // public reviews; only owner-private reviews require a matching user JWT.
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  let callerId: string | null = null;
  if (token) {
    const { data: userData } = await supabase.auth.getUser(token);
    callerId = userData?.user?.id ?? null;
  }
  if (callerId && isConnectedAppToken(token)) {
    return connectedAppForbiddenResponse(cors);
  }

  let body: {
    review_id?: string;
    review_ids?: string[];
    target_locale?: string;
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const targetLocale = body.target_locale?.trim();
  if (!targetLocale) {
    return new Response(JSON.stringify({ error: "target_locale is required" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const ids = body.review_ids ?? (body.review_id ? [body.review_id] : []);
  if (ids.length === 0) {
    return new Response(
      JSON.stringify({ error: "review_id or review_ids is required" }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }

  const isBatch = Array.isArray(body.review_ids);

  try {
    const results = await Promise.all(
      ids.map(async (id) => ({
        review_id: id,
        ...(await translateOne(id, targetLocale, callerId)),
      })),
    );

    if (!isBatch) {
      const single = results[0];
      const httpStatus = single.status === "error"
        ? 503
        : single.status === "forbidden"
        ? 403
        : single.status === "not_found"
        ? 404
        : 200;
      return new Response(JSON.stringify(single), {
        status: httpStatus,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ results }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      }),
      { status: 503, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }
});
