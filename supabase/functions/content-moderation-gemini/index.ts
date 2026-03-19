import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5"; // Match working example import
import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { decode } from "https://deno.land/std@0.203.0/encoding/base64url.ts"; // For JWT decoding
import { getCorsHeaders } from "../_shared/cors.ts";

// --- Rate Limiting Configuration ---
const FUNCTION_NAME = 'content-moderation-gemini'; // Identifier for this function in the rate limit table
const MAX_REQUESTS = 3; // Max requests allowed per user within the window
const WINDOW_SECONDS = 60; // Time window in seconds

// --- Environment Variable Loading ---
const serviceAccountKeyJson = Deno.env.get('GOOGLE_APPLICATION_CREDENTIALS_JSON');
const geminiProjectId = Deno.env.get('GEMINI_PROJECT_ID');
const geminiRegion = Deno.env.get('GEMINI_REGION');

// --- Supabase Environment Variables ---
const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';


if (!serviceAccountKeyJson) {
  console.error("GOOGLE_APPLICATION_CREDENTIALS_JSON is not set in environment variables.");
  Deno.exit(1);
}
if (!geminiProjectId) {
  console.error("GEMINI_PROJECT_ID is not set in environment variables.");
  Deno.exit(1);
}
if (!geminiRegion) {
  console.error("GEMINI_REGION is not set in environment variables.");
  Deno.exit(1);
}
if (!supabaseUrl) {
    console.error("SUPABASE_URL is not set in environment variables.");
    Deno.exit(1);
}
if (!supabaseServiceRoleKey) {
    console.error("SUPABASE_SERVICE_ROLE_KEY is not set in environment variables.");
    Deno.exit(1);
}


const serviceAccount = JSON.parse(serviceAccountKeyJson);

// --- Google Cloud Authentication ---

async function getAccessToken(): Promise<string> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: await createJwt(),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Error fetching access token:", response.status, errorText);
    throw new Error(`Failed to get access token: ${response.status}`);
  }

  const data = await response.json();
  if (!data.access_token) {
    console.error("Access token not found in response:", data);
    throw new Error("Access token not found in response.");
  }
  return data.access_token;
}

async function createJwt(): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600; // Token valid for 1 hour
  const payload = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    exp,
    iat,
  };

  const jwtHeader = {
    alg: "RS256",
    typ: "JWT",
  };

  const encodeBase64Url = (str: string | ArrayBuffer): string => {
    let base64 = '';
    if (typeof str === 'string') {
      base64 = btoa(str);
    } else {
      base64 = btoa(String.fromCharCode(...new Uint8Array(str)));
    }
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };

  const encodedHeader = encodeBase64Url(JSON.stringify(jwtHeader));
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const privateKey = await importPrivateKey(serviceAccount.private_key);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(unsignedToken)
  );

  const encodedSignature = encodeBase64Url(signature);
  return `${unsignedToken}.${encodedSignature}`;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = pem.substring(pemHeader.length, pem.length - pemFooter.length -1).replace(/\s+/g, ''); // Remove newlines and spaces
  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      binaryDer,
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
      },
      true, // exportable
      ["sign"]
    );
  } catch (e) {
    console.error("Error importing private key:", e);
    throw new Error("Failed to import private key.");
  }
}

// --- Type Definitions for Gemini API ---
interface GeminiSafetyRating {
  category: string;
  probability: string; // e.g., "NEGLIGIBLE", "LOW", "MEDIUM", "HIGH"
  blocked?: boolean;
}

interface GeminiPromptFeedback {
  blockReason?: string;
  safetyRatings?: GeminiSafetyRating[];
}

interface GeminiContentPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

interface GeminiCandidateContent {
  role: string;
  parts: GeminiContentPart[];
}

interface GeminiCandidate {
  content: GeminiCandidateContent;
  finishReason: string;
  index: number;
  safetyRatings: GeminiSafetyRating[];
}

interface GeminiApiResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: GeminiPromptFeedback;
}

interface LinkCheckResponseJson {
    contains_link_or_phone: boolean;
}


// --- Gemini API Interaction ---
const GEMINI_MODEL = "gemini-2.5-flash-lite"; // Updated model

async function callGeminiApi(accessToken: string, requestBody: object): Promise<GeminiApiResponse> {
  const apiUrl = `https://${geminiRegion}-aiplatform.googleapis.com/v1/projects/${geminiProjectId}/locations/${geminiRegion}/publishers/google/models/${GEMINI_MODEL}:generateContent`;

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`Gemini API request failed with status ${response.status}: ${errorBody}`);
    throw new Error(`Gemini API request failed: ${response.status}`);
  }

  return await response.json();
}

// --- Helper Function for JWT Decoding ---
// Note: This is a basic decoder for payload extraction, not full verification.
// Supabase gateway handles verification before the function is invoked.
// Define a more specific type for the JWT payload if known, or use Record<string, unknown>
interface JwtPayload {
  sub?: string;
  [key: string]: unknown; // Use unknown instead of any
}

function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      console.error("Invalid JWT structure");
      return null;
    }
    const payload = JSON.parse(new TextDecoder().decode(decode(parts[1])));
    return payload;
  } catch (e) {
    console.error("Error decoding JWT payload:", e);
    return null;
  }
}


// --- Main Server Logic ---

serve(async (req) => {
  const requestOrigin = req.headers.get("origin");
  const cors = getCorsHeaders(requestOrigin || undefined);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  // --- Request Validation ---
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: cors });
  }
  if (req.headers.get("content-type") !== "application/json") {
    return new Response("Bad Request: Content-Type must be application/json", { status: 400, headers: cors });
  }

  // --- Rate Limiting Check ---
  const authHeader = req.headers.get("Authorization");
  let userId: string | null = null;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    const payload = decodeJwtPayload(token);
    if (payload && payload.sub) {
      userId = payload.sub;
    } else {
      console.warn("Could not extract user ID (sub) from JWT payload.");
      // Optionally return 401 if user ID is strictly required
      // return new Response("Unauthorized: Invalid token payload", { status: 401 });
    }
  } else {
    // If auth is strictly required, return 401. If anonymous access is sometimes allowed, handle accordingly.
    // Assuming authenticated users are required for this function:
    return new Response("Unauthorized: Missing or invalid Authorization header", { status: 401, headers: cors });
  }

  if (!userId) {
     // This case might be redundant if the above returns 401, but good for clarity
     return new Response("Unauthorized: User ID could not be determined", { status: 401, headers: cors });
  }

  // --- Debug Logging for Rate Limiting ---
  console.log("[Rate Limit Debug] Authorization Header:", authHeader);
  console.log("[Rate Limit Debug] Extracted User ID:", userId);
  // --- End Debug Logging ---

  // --- Database Rate Limiting Logic ---
  try {
    // Create Supabase client with admin privileges using pre-loaded variables
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    const now = new Date();
    const windowStartTime = new Date(now.getTime() - WINDOW_SECONDS * 1000);

    // Fetch the current rate limit record for this user and function from the 'service' schema
    const { data: limitRecord, error: fetchError } = await supabaseAdmin
      .schema('service') // Specify schema before from()
      .from('moderation_rate_limits')
      .select('request_count, window_start_time')
      .eq('user_id', userId)
      .eq('function_name', FUNCTION_NAME)
      .maybeSingle(); // Use maybeSingle to handle cases where the record doesn't exist yet

    if (fetchError) {
      console.error("Error fetching rate limit record:", fetchError);
      throw new Error("Failed to fetch rate limit status."); // Will be caught below
    }

    if (limitRecord && new Date(limitRecord.window_start_time) > windowStartTime) {
      // Record exists and is within the current window
      if (limitRecord.request_count >= MAX_REQUESTS) {
        // Limit exceeded
        console.log(`Rate limit exceeded for user ${userId}. Count: ${limitRecord.request_count}, Limit: ${MAX_REQUESTS}`);
        return new Response(
          JSON.stringify({ error: "Too Many Requests", message: `Rate limit exceeded. Please wait a minute before trying again.` }), // Updated message
          { status: 429, headers: { ...cors, 'Content-Type': 'application/json' } }
        );
      } else {
        // Limit not exceeded, increment count in the 'service' schema
        const { error: updateError } = await supabaseAdmin
          .schema('service') // Specify schema before from()
          .from('moderation_rate_limits')
          .update({ request_count: limitRecord.request_count + 1 })
          .eq('user_id', userId)
          .eq('function_name', FUNCTION_NAME);

        if (updateError) {
          console.error("Error incrementing rate limit count:", updateError);
          throw new Error("Failed to update rate limit count."); // Will be caught below
        }
        console.log(`User ${userId} rate limit count updated to ${limitRecord.request_count + 1}`);
      }
    } else {
      // No record exists, or the existing record is outside the window -> Reset/create the record in the 'service' schema
      const { error: upsertError } = await supabaseAdmin
        .schema('service') // Specify schema before from()
        .from('moderation_rate_limits')
        .upsert({
          user_id: userId,
          function_name: FUNCTION_NAME,
          request_count: 1,
          window_start_time: now.toISOString() // Reset window start time
        }, { onConflict: 'user_id, function_name' }); // Specify conflict target

      if (upsertError) {
        console.error("Error upserting rate limit record:", upsertError);
        throw new Error("Failed to initialize/reset rate limit record."); // Will be caught below
      }
      console.log(`User ${userId} rate limit window reset. Count: 1`);
    }

  } catch (dbError) {
    console.error("Database error during rate limiting check:", dbError);
    // Fail closed (deny request) for safety
    return new Response(JSON.stringify({ error: "Internal Server Error", message: `Rate limiting check failed: ${dbError.message}` }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
  // --- End Database Rate Limiting Logic ---


  let requestPayload: { text?: string; imageBase64?: string };
  try {
    requestPayload = await req.json();
  } catch (e) {
    return new Response(`Bad Request: Invalid JSON payload. ${e.message}`, { status: 400, headers: cors });
  }

  const { text, imageBase64 } = requestPayload;

  if (!text && !imageBase64) {
    return new Response("Bad Request: Missing 'text' or 'imageBase64' in request body.", { status: 400, headers: cors });
  }
  if (text && imageBase64) {
    return new Response("Bad Request: Provide either 'text' or 'imageBase64', not both.", { status: 400, headers: cors });
  }

  // --- Moderation Logic (Placeholder) ---
  console.log("Received request:", { text: text ? text.substring(0, 50) + '...' : undefined, imageBase64: imageBase64 ? 'Present' : undefined });

  try {
    const accessToken = await getAccessToken();

    // --- Step 1: Initial Safety Check ---
    const safetySettings = [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_LOW_AND_ABOVE" }, // Increased sensitivity
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_LOW_AND_ABOVE" }, // Increased sensitivity
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
    ];

    const parts = [];
    if (text) {
      parts.push({ text: text });
    } else if (imageBase64) {
      // *** MODIFICATION START ***
      // Add a simple text part first, similar to the working function
      parts.push({ text: "Evaluate the safety of the following image content." });
      // Then add the image part
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: imageBase64 } });
      // *** MODIFICATION END ***
    }

    const safetyCheckRequestBody = {
      contents: [{ role: 'user', parts }], // Now parts will have [text, inlineData] or just [text]
      safetySettings,
      generationConfig: { // Add a minimal generation config to ensure the API call is valid
        maxOutputTokens: 1, // We don't need generated content here, just the safety check
      }
    };

    console.log("Performing initial safety check...");
    const safetyCheckResponse = await callGeminiApi(accessToken, safetyCheckRequestBody);

    // Check for safety blocks
    const promptFeedback: GeminiPromptFeedback | undefined = safetyCheckResponse.promptFeedback;
    if (promptFeedback?.blockReason) {
      const blockedCategories = promptFeedback.safetyRatings
        ?.filter((rating: GeminiSafetyRating) => rating.blocked)
        .map((rating: GeminiSafetyRating) => rating.category.replace('HARM_CATEGORY_', ''))
        .join(', ');
      const reason = `Content blocked due to safety settings: ${promptFeedback.blockReason}${blockedCategories ? ` (${blockedCategories})` : ''}`;
      console.log(`Safety check failed: ${reason}`);
      return new Response(JSON.stringify({ safe: false, reason: reason }), {
        status: 200, // Return 200 OK as the function executed successfully, but content is unsafe
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    console.log("Initial safety check passed.");

    // --- Step 2: Link/Phone Number Detection ---
    console.log("Performing link/phone number detection check...");

    let linkCheckPrompt = "";
    const linkCheckParts = [];

    if (text) {
      linkCheckPrompt = `Analyze the following text. Does it contain any URLs, web links (including obfuscated forms like 'example dot com'), or phone numbers (including variations like '555-one-two-three-four')? Respond ONLY with valid JSON containing a single key "contains_link_or_phone" which is a boolean (true or false). Do not add any other text or explanations. Text: "${text}"`;
      linkCheckParts.push({ text: linkCheckPrompt });
    } else if (imageBase64) {
      linkCheckPrompt = `Analyze the text visible within the following image. Does this text contain any URLs, web links (including obfuscated forms like 'example dot com'), or phone numbers (including variations like '555-one-two-three-four')? Respond ONLY with valid JSON containing a single key "contains_link_or_phone" which is a boolean (true or false). Do not add any other text or explanations.`;
      // *** Ensure text part comes first here too ***
      linkCheckParts.push({ text: linkCheckPrompt });
      linkCheckParts.push({ inlineData: { mimeType: 'image/jpeg', data: imageBase64 } });
    }

    const linkCheckRequestBody = {
      contents: [{ role: 'user', parts: linkCheckParts }],
      // Use less strict safety settings here, as the primary check was done.
      // Or remove safety settings if we only care about the generated JSON.
      // Let's keep minimal safety to avoid generating harmful *responses* if the prompt is somehow misinterpreted.
      safetySettings: [
         { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
         { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
         { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
         { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
      ],
      generationConfig: {
        responseMimeType: "application/json", // Expect JSON response
        // candidateCount: 1, // Default is 1
        // temperature: 0.2 // Lower temperature for more deterministic JSON output
      }
    };

    const linkCheckResponse = await callGeminiApi(accessToken, linkCheckRequestBody);

    // Extract and parse the JSON response from Gemini
    let containsLinkOrPhone = false;
    try {
      // Check if candidates exist and have content
      if (linkCheckResponse.candidates && linkCheckResponse.candidates.length > 0 && linkCheckResponse.candidates[0].content?.parts?.length > 0 && linkCheckResponse.candidates[0].content.parts[0].text) {
        const responseText = linkCheckResponse.candidates[0].content.parts[0].text;
        console.log("Raw link/phone check response text:", responseText);
        const parsedJson: LinkCheckResponseJson = JSON.parse(responseText);
        if (typeof parsedJson.contains_link_or_phone === 'boolean') {
          containsLinkOrPhone = parsedJson.contains_link_or_phone;
        } else {
           console.warn("Link/phone check response JSON did not contain a boolean 'contains_link_or_phone' key:", parsedJson);
        }
      } else {
         console.warn("Link/phone check response structure unexpected or empty:", JSON.stringify(linkCheckResponse, null, 2));
         // If the response is empty or malformed, assume no link/phone detected for safety, but log it.
      }
    } catch (e) {
      console.error("Error parsing link/phone check JSON response:", e instanceof Error ? e.message : String(e));
      // Defaulting to false on error, assuming no link/phone detected if parsing fails.
    }

    if (containsLinkOrPhone) {
      const reason = "Detected potential link or phone number";
      console.log(`Link/phone check failed: ${reason}`);
      return new Response(JSON.stringify({ safe: false, reason: reason }), {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    console.log("Link/phone number check passed.");

    // --- Step 3: Explicit High-Sensitivity Check ---
    console.log("Performing explicit high-sensitivity check...");

    const explicitCheckParts = [];
    let explicitCheckPrompt = "";
    // Define the expected JSON structure for clarity
    interface ExplicitCheckResponseJson {
        is_problematic: boolean;
        reason: string;
    }
    const explicitCheckResponseFormat = `Respond ONLY with valid JSON containing two keys: "is_problematic" (boolean: true if any problematic content is found, false otherwise) and "reason" (string: a brief explanation if problematic, or 'None' if not).`;

    if (text) {
      explicitCheckPrompt = `Critically evaluate the following text with maximum sensitivity. Does it contain any form of obscenity, hate speech, harassment, sexually explicit material, or dangerous content, even if subtle or implied? ${explicitCheckResponseFormat} Text: "${text}"`;
      explicitCheckParts.push({ text: explicitCheckPrompt });
    } else if (imageBase64) {
      explicitCheckPrompt = `Critically evaluate the text and imagery within the following image with maximum sensitivity. Does it contain any form of obscenity, hate speech, harassment, sexually explicit material, or dangerous content, even if subtle or implied? ${explicitCheckResponseFormat}`;
       // *** Ensure text part comes first here too ***
      explicitCheckParts.push({ text: explicitCheckPrompt });
      explicitCheckParts.push({ inlineData: { mimeType: 'image/jpeg', data: imageBase64 } }); // Re-add image
    }

    const explicitCheckRequestBody = {
      contents: [{ role: 'user', parts: explicitCheckParts }],
      // Use minimal safety settings here as we want the model's judgment based on the prompt,
      // but still block truly egregious *responses* from the model itself.
      safetySettings: [
         { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
         { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
         { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
         { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        // temperature: 0.1 // Consider adding low temp for deterministic JSON
      }
    };

    const explicitCheckResponse = await callGeminiApi(accessToken, explicitCheckRequestBody);

    // Parse the explicit check response
    let isProblematic = false;
    let problematicReason = "Evaluation error"; // Default reason if parsing fails

    try {
      if (explicitCheckResponse.candidates && explicitCheckResponse.candidates.length > 0 && explicitCheckResponse.candidates[0].content?.parts?.length > 0 && explicitCheckResponse.candidates[0].content.parts[0].text) {
        const responseText = explicitCheckResponse.candidates[0].content.parts[0].text;
        console.log("Raw explicit check response text:", responseText);
        const parsedJson: ExplicitCheckResponseJson = JSON.parse(responseText);
        if (typeof parsedJson.is_problematic === 'boolean') {
          isProblematic = parsedJson.is_problematic;
          problematicReason = parsedJson.reason || (isProblematic ? "Problematic content detected" : "None");
        } else {
           console.warn("Explicit check response JSON did not contain a boolean 'is_problematic' key:", parsedJson);
           isProblematic = true; // Fail safe: assume problematic if format is wrong
           problematicReason = "Invalid format in evaluation response";
        }
      } else {
         console.warn("Explicit check response structure unexpected or empty:", JSON.stringify(explicitCheckResponse, null, 2));
         isProblematic = true; // Fail safe: assume problematic if structure is wrong
         problematicReason = "Malformed response from evaluation model";
      }
    } catch (e) {
      console.error("Error parsing explicit check JSON response:", e instanceof Error ? e.message : String(e));
      isProblematic = true; // Fail safe: assume problematic if parsing fails
      problematicReason = "Error parsing evaluation response";
    }

    if (isProblematic) {
      console.log(`Explicit check failed: ${problematicReason}`);
      return new Response(JSON.stringify({ safe: false, reason: `Explicit check: ${problematicReason}` }), {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    console.log("Explicit high-sensitivity check passed.");

    // If all checks pass
    return new Response(JSON.stringify({ safe: true }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Error during moderation:', error);
    return new Response(JSON.stringify({ error: "Internal Server Error", message: error.message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
});

console.log(`Content moderation function started.`);
