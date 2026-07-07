import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
import { GROQ_DEFAULT_MODEL, OPENAI_DEFAULT_MODEL, GEMINI_DEFAULT_MODEL, CEREBRAS_DEFAULT_MODEL } from "../_shared/ai-models.ts";
// --- Provider credentials ---
const cerebrasApiKey = Deno.env.get('CEREBRAS_API_KEY');
const groqApiKey = Deno.env.get('GROQ_API_KEY');
const openaiApiKey = Deno.env.get('OPENAI_API_KEY_NON_PERSONAL');
const serviceAccountKey = Deno.env.get('GOOGLE_APPLICATION_CREDENTIALS_JSON');
const geminiProjectId = Deno.env.get('GEMINI_PROJECT_ID') ?? '';
const geminiRegion = Deno.env.get('GEMINI_REGION') ?? '';
const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error("Supabase configuration is not set in environment variables.");
  Deno.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
function getErrorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return 'Unknown error occurred';
}
// Pulls a provider error code/type out of a JSON error body (falls back to a
// snippet of the raw body) so we can detect model-unavailable responses.
function extractProviderErrorCode(body) {
  try {
    const parsed = JSON.parse(body);
    return String(parsed?.error?.code ?? parsed?.error?.type ?? '');
  } catch {
    return typeof body === 'string' ? body.slice(0, 200) : '';
  }
}
// Returns true for provider errors that warrant cascading to the next provider:
// transient/network/parse errors, rate limits, and model-unavailable errors
// (e.g. a decommissioned model — Llama 4 Scout deactivates 2026-07-17).
function isRetriableProviderError(status, errorCode) {
  if (status === undefined) return true; // network/timeout/JSON parse errors
  if (status === 429 || status === 408 || status >= 500) return true;
  if (status === 404) return true; // model/endpoint not found
  const code = (errorCode ?? '').toLowerCase();
  return code.includes('decommission') || code.includes('deactiv') ||
    code.includes('model_not_found') || code.includes('does_not_exist') ||
    code.includes('does not exist');
}
function logInfoEvent(requestId, event, details = {}) {
  console.log(`[parse-coffee-label] ${event}`, {
    requestId,
    ...details
  });
}
function logWarnEvent(requestId, event, details = {}) {
  console.warn(`[parse-coffee-label] ${event}`, {
    requestId,
    ...details
  });
}
function logErrorEvent(requestId, event, error, details = {}) {
  console.error(`[parse-coffee-label] ${event}`, {
    requestId,
    ...details,
    error: {
      name: error instanceof Error ? error.name : typeof error,
      message: getErrorMessage(error),
      status: typeof error === 'object' && error && 'status' in error ? error.status : undefined
    }
  });
}
function summarizeModelResponse(content) {
  const trimmed = content.trim();
  return {
    contentLength: trimmed.length,
    startsWithJsonObject: trimmed.startsWith('{'),
    startsWithJsonArray: trimmed.startsWith('['),
    containsCodeFence: trimmed.includes('```'),
    containsNoCoffeeLabelError: trimmed.includes('No coffee labels detected')
  };
}
function summarizeParsedResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return {
      resultType: Array.isArray(result) ? 'array' : typeof result
    };
  }
  const resultRecord = result;
  const entries = Object.entries(resultRecord);
  return {
    fieldCount: entries.length,
    populatedFieldCount: entries.filter(([, value])=>value !== null && value !== '' && value !== undefined).length,
    keys: entries.map(([key])=>key),
    hasError: Object.prototype.hasOwnProperty.call(resultRecord, 'error')
  };
}
// --- Gemini JWT auth ---
async function getGeminiAccessToken() {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: await createGeminiJwt()
    })
  });
  const data = await response.json();
  return data.access_token;
}
async function createGeminiJwt() {
  const serviceAccount = JSON.parse(serviceAccountKey ?? '');
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;
  const payload = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    exp,
    iat
  };
  const encoder = new TextEncoder();
  const jwtHeader = {
    alg: "RS256",
    typ: "JWT"
  };
  const encodeBase64Url = (str)=>btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const encodedHeader = encodeBase64Url(JSON.stringify(jwtHeader));
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await importGeminiPrivateKey(serviceAccount.private_key), encoder.encode(unsignedToken));
  const encodedSignature = encodeBase64Url(String.fromCharCode(...new Uint8Array(signature)));
  return `${unsignedToken}.${encodedSignature}`;
}
function importGeminiPrivateKey(pem) {
  const binaryDer = Uint8Array.from(atob(pem.replace(/-----\w+ PRIVATE KEY-----/g, "").replace(/\s+/g, "")), (c)=>c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", binaryDer, {
    name: "RSASSA-PKCS1-v1_5",
    hash: "SHA-256"
  }, true, [
    "sign"
  ]);
}
// --- Roast date validation helpers ---
function parseRoastDate(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // Require strict YYYY-MM-DD shape to avoid Date() accepting odd inputs.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null; // rejects e.g. 2026-02-29
  }
  return d;
}
function todayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
function sixMonthsBefore(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 6, d.getUTCDate()));
}
function classifyRoastDate(d, today) {
  if (d === null) return 'invalid';
  if (d.getTime() > today.getTime()) return 'future';
  if (d.getTime() < sixMonthsBefore(today).getTime()) return 'too_old';
  return 'ok';
}
function formatUtcDate(d) {
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function getStrictRoastDatePrompt(ocrText, originalRoastDate, classification, locale) {
  const today = formatUtcDate(todayUtc());
  const reason = classification === 'future'
    ? `it is AFTER today's date (${today}), which is impossible for a roast date`
    : `it is more than 6 months before today (${today}), which is unusual and often indicates a misread best-by / expiration date rather than a true roast date`;
  let prompt = `You previously extracted a roast date from a coffee bag image, but the value "${originalRoastDate}" was rejected because ${reason}.

Re-examine the image(s) and return ONLY the roast date. Rules:
- Today's date is ${today}. The roast date MUST be on or before today; never return a date after ${today}.
- Printed dates on coffee bags are usually one of: roast date, best-by / expiration date (typically 12-24 months AFTER the roast date), or harvest date. Never confuse these.
- If the only printed date is a best-by or expiration date, return null.
- If the roast date you identify is more than 6 months before today (${today}), only return it if you are confident the label clearly labels it as a roast date (e.g. "Roasted on", "Roast date", "Tostado el"); otherwise return null.
- If you cannot identify a true roast date with confidence, return null.
- Respond with valid JSON only, no code blocks, no backticks, in this exact shape:
  { "roastDate": "YYYY-MM-DD" }
  or
  { "roastDate": null }
- Locale for any text fields is ${locale}, but only the roastDate field is needed.`;
  if (ocrText && ocrText.trim().length > 0) {
    prompt = `${prompt}\n\nAdditional OCR context from mobile device: ${ocrText}`;
  }
  return prompt;
}
serve(async (req)=>{
  const requestId = crypto.randomUUID();
  const requestOrigin = req.headers.get("origin");
  const cors = getCorsHeaders(requestOrigin || undefined);
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: cors
    });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: cors
    });
  }
  const body = await req.json();
  const { imagesBase64, ocrText, locale, userId } = body;
  logInfoEvent(requestId, 'request_received', {
    imageCount: Array.isArray(imagesBase64) ? imagesBase64.length : 0,
    ocrTextLength: typeof ocrText === 'string' ? ocrText.trim().length : 0,
    locale: typeof locale === 'string' ? locale : null,
    hasUserId: typeof userId === 'string' && userId.length > 0
  });
  const currentYear = new Date().getFullYear();
  const getSystemPrompt = (ocrText)=>{
    let basePrompt = `Extract the following fields from the image and respond in JSON format as a single JSON object (do not return an array). If there are multiple images, combine the info into one response. Translate suitable fields to ${locale}. Only respond with valid JSON. No code blocks, no backticks. If there are upper case values, convert them to capitalized case. Use the following JSON structure:
  {
    "roaster": "roaster",
    "name": "name",
    "origin": "origin (country of origin, translated to ${locale})",
    "farm": "farm",
    "farmer": "farmer",
    "variety": "variety",
    "processingMethod": "Processing Method (translated to ${locale})",
    "elevation": "elevation (number only)",
    "harvestDate": "always null, assume that there's no harvest data in the image)",
    "roastDate": "roast date (YYYY-MM-DD, assume the current year is ${currentYear} if not explicitly provided)",
    "region": "region (region of country of origin, translated to ${locale})",
    "roastLevel": "roast level (translated to ${locale})",
    "cuppingScore": "cupping score",
    "tastingNotes": "tasting notes (translated to ${locale}, separated by comma, Capitalized. No untranslated notes.)",
    "packageWeightGrams": "number, up to 2 decimal places, min. value 0.1"
  }
  If no coffee labels are detected in any images, return:
  { "error": "No coffee labels detected" }`;
    if (ocrText && ocrText.trim().length > 0) {
      basePrompt = `${basePrompt}\n\nAdditional OCR context from mobile device: ${ocrText}`;
    }
    return basePrompt;
  };
  async function isProUser(userId) {
    const { data, error } = await supabase.from('pro_users').select('user_id').eq('user_id', userId);
    if (error) {
      logErrorEvent(requestId, 'pro_user_lookup_failed', error);
      return false;
    }
    return data.length > 0;
  }
  async function getMonthlyTokensUsed(userId) {
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const { data, error } = await supabase.from('parse_coffee_label_invocations').select('tokens_used').eq('user_id', userId).gte('invoked_at', startOfMonth);
    if (error) {
      logErrorEvent(requestId, 'token_usage_lookup_failed', error);
      return 0;
    }
    return data.reduce((acc, row)=>acc + row.tokens_used, 0);
  }
  function normalizeResult(parsedContent) {
    const result = Array.isArray(parsedContent) ? parsedContent[0] : parsedContent;
    if (result && typeof result === 'object') {
      Object.keys(result).forEach((key)=>{
        if (result[key] === "Unknown") {
          result[key] = null;
        }
      });
    }
    return result;
  }
  function parseModelResponse(content, provider) {
    try {
      return normalizeResult(JSON.parse(content));
    } catch (parseError) {
      logErrorEvent(requestId, `${provider.toLowerCase()}_invalid_json`, parseError, summarizeModelResponse(content));
      throw new Error(`${provider} returned an invalid JSON response`);
    }
  }
  // --- Cerebras processing (primary) ---
  const processWithCerebras = async (base64Images, systemPrompt)=>{
    const userContent = [
      {
        type: "text",
        text: `locale = ${locale}`
      }
    ];
    if (base64Images && base64Images.length > 0) {
      base64Images.forEach((base64)=>{
        userContent.push({
          type: "image_url",
          image_url: {
            url: `data:image/jpeg;base64,${base64}`
          }
        });
      });
    } else if (ocrText && ocrText.trim().length > 0) {
      userContent.push({
        type: "text",
        text: `OCR context from mobile device: ${ocrText}`
      });
    }
    const response = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cerebrasApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: CEREBRAS_DEFAULT_MODEL,
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: userContent
          }
        ],
        temperature: 1,
        top_p: 0.95,
        max_completion_tokens: 1024,
        stream: false
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      logWarnEvent(requestId, 'cerebras_http_error', {
        status: response.status,
        responseBodyLength: errorText.length
      });
      const err = new Error(`Cerebras API request failed with status ${response.status}`);
      err.status = response.status;
      err.code = extractProviderErrorCode(errorText);
      throw err;
    }
    const jsonResponse = await response.json();
    const content = jsonResponse.choices[0].message.content;
    return parseModelResponse(content, 'Cerebras');
  };
  // --- Groq processing ---
  const processWithGroq = async (base64Images, systemPrompt)=>{
    const userContent = [
      {
        type: "text",
        text: `locale = ${locale}`
      }
    ];
    if (base64Images && base64Images.length > 0) {
      base64Images.forEach((base64)=>{
        userContent.push({
          type: "image_url",
          image_url: {
            url: `data:image/jpeg;base64,${base64}`
          }
        });
      });
    } else if (ocrText && ocrText.trim().length > 0) {
      userContent.push({
        type: "text",
        text: `OCR context from mobile device: ${ocrText}`
      });
    }
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROQ_DEFAULT_MODEL,
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: userContent
          }
        ],
        temperature: 1,
        max_completion_tokens: 1024,
        top_p: 1,
        stream: false
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      logWarnEvent(requestId, 'groq_http_error', {
        status: response.status,
        responseBodyLength: errorText.length
      });
      const err = new Error(`Groq API request failed with status ${response.status}`);
      err.status = response.status;
      err.code = extractProviderErrorCode(errorText);
      throw err;
    }
    const jsonResponse = await response.json();
    const content = jsonResponse.choices[0].message.content;
    return parseModelResponse(content, 'Groq');
  };
  // --- OpenAI processing ---
  const processWithOpenAI = async (base64Images, systemPrompt)=>{
    const userContent = [
      {
        type: "text",
        text: `locale = ${locale}`
      }
    ];
    if (base64Images && base64Images.length > 0) {
      base64Images.forEach((base64)=>{
        userContent.push({
          type: "image_url",
          image_url: {
            url: `data:image/jpeg;base64,${base64}`
          }
        });
      });
    } else if (ocrText && ocrText.trim().length > 0) {
      userContent.push({
        type: "text",
        text: `OCR context from mobile device: ${ocrText}`
      });
    }
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_DEFAULT_MODEL,
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: userContent
          }
        ],
        max_completion_tokens: 4096
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      logWarnEvent(requestId, 'openai_http_error', {
        status: response.status,
        responseBodyLength: errorText.length
      });
      const err = new Error(`OpenAI API request failed with status ${response.status}`);
      err.status = response.status;
      err.code = extractProviderErrorCode(errorText);
      throw err;
    }
    const jsonResponse = await response.json();
    const content = jsonResponse.choices[0].message.content;
    return parseModelResponse(content, 'OpenAI');
  };
  // --- Gemini processing (fallback) ---
  const processWithGemini = async (base64Images, systemPrompt)=>{
    const accessToken = await getGeminiAccessToken();
    const parts = [
      {
        text: systemPrompt
      }
    ];
    if (base64Images && base64Images.length > 0) {
      base64Images.forEach((base64)=>{
        parts.push({
          inlineData: {
            mimeType: 'image/jpeg',
            data: base64
          }
        });
      });
    }
    if (ocrText && ocrText.trim().length > 0) {
      parts.push({
        text: `OCR context from mobile device: ${ocrText}`
      });
    }
    parts.push({
      text: `locale = ${locale}`
    });
    const requestBody = {
      contents: [
        {
          role: 'user',
          parts
        }
      ],
      generationConfig: {
        responseMimeType: "application/json"
      }
    };
    const response = await fetch(`https://${geminiRegion}-aiplatform.googleapis.com/v1/projects/${geminiProjectId}/locations/${geminiRegion}/publishers/google/models/${GEMINI_DEFAULT_MODEL}:generateContent`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
    if (!response.ok) {
      const errorText = await response.text();
      logWarnEvent(requestId, 'gemini_http_error', {
        status: response.status,
        responseBodyLength: errorText.length
      });
      throw new Error(`Gemini API request failed with status ${response.status}`);
    }
    const jsonResponse = await response.json();
    const content = jsonResponse.candidates[0].content.parts[0].text;
    return parseModelResponse(content, 'Gemini');
  };
  try {
    const proUser = await isProUser(userId);
    const tokenLimit = proUser ? 500 : 20;
    const tokensUsedThisMonth = await getMonthlyTokensUsed(userId);
    const tokensToUse = imagesBase64 ? imagesBase64.length : 1;
    if (tokensUsedThisMonth + tokensToUse > tokenLimit) {
      logWarnEvent(requestId, 'invocation_limit_reached', {
        proUser,
        tokensUsedThisMonth,
        tokensToUse,
        tokenLimit
      });
      return new Response(JSON.stringify({
        error: 'Invocation limit reached',
        message: 'Sorry, you reached your token limit for image recognition this month'
      }), {
        status: 200,
        headers: {
          ...cors,
          'Content-Type': 'application/json'
        }
      });
    }
    const hasImages = imagesBase64 && imagesBase64.length > 0;
    const hasOcrText = ocrText && ocrText.trim().length > 0;
    if (!hasImages && !hasOcrText) {
      return new Response(JSON.stringify({
        error: 'No images or OCR text provided'
      }), {
        status: 400,
        headers: {
          ...cors,
          'Content-Type': 'application/json'
        }
      });
    }
    const images = hasImages ? imagesBase64.slice(0, 2) : null;
    const primaryPrompt = getSystemPrompt(ocrText);
    // Ordered provider chain: Cerebras (primary) → Groq → OpenAI → Gemini. Each
    // tier runs only if its credential is configured; on a retriable error
    // (incl. a decommissioned model) we cascade to the next configured tier.
    const providerChain = [
      { key: 'cerebras', configured: !!cerebrasApiKey, run: processWithCerebras },
      { key: 'groq', configured: !!groqApiKey, run: processWithGroq },
      { key: 'openai', configured: !!openaiApiKey, run: processWithOpenAI },
      { key: 'gemini', configured: !!serviceAccountKey, run: processWithGemini }
    ].filter((p)=>p.configured);
    if (providerChain.length === 0) {
      throw new Error('No AI provider configured (set one of CEREBRAS_API_KEY, GROQ_API_KEY, OPENAI_API_KEY_NON_PERSONAL, GOOGLE_APPLICATION_CREDENTIALS_JSON)');
    }
    let result;
    let used = providerChain[0];
    for(let i = 0; i < providerChain.length; i++){
      const candidate = providerChain[i];
      const isLast = i === providerChain.length - 1;
      try {
        result = await candidate.run(images, primaryPrompt);
        used = candidate;
        break;
      } catch (providerError) {
        if (!isLast && isRetriableProviderError(providerError.status, providerError.code)) {
          logWarnEvent(requestId, 'provider_fallback', {
            from: candidate.key,
            to: providerChain[i + 1].key,
            status: providerError.status ?? 'network_or_parse_error',
            code: providerError.code
          });
          continue;
        }
        throw providerError;
      }
    }
    const provider = used.key;
    // --- Roast date re-check ---
    // Skip if the result is the error envelope or has no roastDate field at all.
    if (result && typeof result === 'object' && !Array.isArray(result) && !result.error && 'roastDate' in result) {
      const today = todayUtc();
      const originalRoastDate = result.roastDate;
      const parsed = parseRoastDate(originalRoastDate);
      const classification = classifyRoastDate(parsed, today);
      if (originalRoastDate !== null && originalRoastDate !== undefined && parsed === null) {
        // Unparseable string the model returned; coerce to null without re-checking.
        result.roastDate = null;
      } else if (classification === 'future' || classification === 'too_old') {
        logInfoEvent(requestId, 'roast_date_recheck_triggered', {
          provider,
          classification,
          originalRoastDate
        });
        const strictPrompt = getStrictRoastDatePrompt(ocrText, originalRoastDate, classification, locale);
        let recheckRoastDate = null;
        let recheckParsed = null;
        let recheckClassification = 'invalid';
        try {
          const recheckResult = await used.run(images, strictPrompt);
          if (recheckResult && typeof recheckResult === 'object' && !Array.isArray(recheckResult) && 'roastDate' in recheckResult) {
            recheckRoastDate = recheckResult.roastDate ?? null;
            recheckParsed = parseRoastDate(recheckRoastDate);
            recheckClassification = classifyRoastDate(recheckParsed, today);
          }
        } catch (recheckError) {
          logErrorEvent(requestId, 'roast_date_recheck_failed', recheckError, {
            provider,
            classification,
            originalRoastDate
          });
        }
        let finalRoastDate;
        if (classification === 'future') {
          // Accept the re-check only if it returned a valid non-future date.
          finalRoastDate = recheckParsed !== null && recheckClassification !== 'future'
            ? recheckRoastDate
            : null;
        } else {
          // too_old: keep first-pass date unless re-check returned a valid date (old or fresh).
          finalRoastDate = recheckParsed !== null && recheckClassification !== 'future'
            ? recheckRoastDate
            : originalRoastDate;
        }
        result.roastDate = finalRoastDate;
        logInfoEvent(requestId, 'roast_date_recheck_result', {
          provider,
          classification,
          originalRoastDate,
          recheckRoastDate,
          recheckClassification,
          finalRoastDate
        });
      }
    }
    logInfoEvent(requestId, 'parse_succeeded', {
      provider,
      tokensToUse,
      resultSummary: summarizeParsedResult(result)
    });
    await supabase.from('parse_coffee_label_invocations').insert([
      {
        user_id: userId,
        invoked_at: new Date().toISOString(),
        tokens_used: tokensToUse
      }
    ]);
    return new Response(JSON.stringify(result), {
      headers: {
        ...cors,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    logErrorEvent(requestId, 'request_failed', error);
    return new Response(JSON.stringify({
      error: getErrorMessage(error)
    }), {
      headers: {
        ...cors,
        'Content-Type': 'application/json'
      }
    });
  }
});
