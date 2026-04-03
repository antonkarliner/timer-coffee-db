import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
// --- Provider credentials ---
const groqApiKey = Deno.env.get('GROQ_API_KEY');
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
// Returns true for transient Groq errors that warrant a Gemini fallback
function isGroqRetriableError(status) {
  if (status === undefined) return true; // network/timeout/JSON parse errors
  return status === 429 || status === 408 || status >= 500;
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
  // --- Groq processing ---
  const processWithGroq = async (base64Images)=>{
    const systemPrompt = getSystemPrompt(ocrText);
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
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
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
      throw err;
    }
    const jsonResponse = await response.json();
    const content = jsonResponse.choices[0].message.content;
    return parseModelResponse(content, 'Groq');
  };
  // --- Gemini processing (fallback) ---
  const processWithGemini = async (base64Images)=>{
    const systemPrompt = getSystemPrompt(ocrText);
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
    const response = await fetch(`https://${geminiRegion}-aiplatform.googleapis.com/v1/projects/${geminiProjectId}/locations/${geminiRegion}/publishers/google/models/gemini-2.5-flash-lite:generateContent`, {
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
    const tokenLimit = proUser ? 500 : 10;
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
    let result;
    let provider = 'groq';
    if (groqApiKey) {
      try {
        result = await processWithGroq(images);
      } catch (groqError) {
        const status = groqError.status;
        if (isGroqRetriableError(status) && serviceAccountKey) {
          logWarnEvent(requestId, 'groq_fallback_to_gemini', {
            status: status ?? 'network_or_parse_error'
          });
          provider = 'gemini';
          result = await processWithGemini(images);
        } else {
          throw groqError;
        }
      }
    } else if (serviceAccountKey) {
      logInfoEvent(requestId, 'gemini_direct');
      provider = 'gemini';
      result = await processWithGemini(images);
    } else {
      throw new Error('No AI provider configured (missing GROQ_API_KEY and GOOGLE_APPLICATION_CREDENTIALS_JSON)');
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
