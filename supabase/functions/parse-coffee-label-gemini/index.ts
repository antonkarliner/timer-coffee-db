import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
// Load service account credentials from the environment variable
const serviceAccountKey = Deno.env.get('GOOGLE_APPLICATION_CREDENTIALS_JSON');
if (!serviceAccountKey) {
  console.error("Service account key is not set in environment variables.");
  Deno.exit(1);
}
const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const geminiProjectId = Deno.env.get('GEMINI_PROJECT_ID') ?? '';
const geminiRegion = Deno.env.get('GEMINI_REGION') ?? '';
if (!supabaseUrl || !supabaseServiceRoleKey || !geminiProjectId || !geminiRegion) {
  console.error("Supabase or Google Vertex AI configuration is not set in environment variables.");
  Deno.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
async function getAccessToken() {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: await createJwt()
    })
  });
  const data = await response.json();
  return data.access_token;
}
async function createJwt() {
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
  const encodeBase64Url = (str)=>{
    return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const encodedHeader = encodeBase64Url(JSON.stringify(jwtHeader));
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await importPrivateKey(serviceAccount.private_key), encoder.encode(unsignedToken));
  const encodedSignature = encodeBase64Url(String.fromCharCode(...new Uint8Array(signature)));
  return `${unsignedToken}.${encodedSignature}`;
}
function importPrivateKey(pem) {
  const binaryDer = Uint8Array.from(atob(pem.replace(/-----\w+ PRIVATE KEY-----/g, "").replace(/\s+/g, "")), (c)=>c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", binaryDer, {
    name: "RSASSA-PKCS1-v1_5",
    hash: "SHA-256"
  }, true, [
    "sign"
  ]);
}
serve(async (req)=>{
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
  const { imagesBase64, locale, userId } = body;
  // Detect the current year for more accurate roast date handling.
  const currentYear = new Date().getFullYear();
  // Updated prompt with instructions to return a single JSON object and include the current year.
  const instructions = `Extract the following fields from the image and respond in JSON format as a single JSON object (do not return an array). If there are multiple images, combine the info into one response. Translate suitable fields to ${locale}. Only respond with valid JSON. No code blocks, no backticks. If there are upper case values, convert them to capitalized case. Use the following JSON structure:
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
  async function isProUser(userId) {
    const { data, error } = await supabase.from('pro_users').select('user_id').eq('user_id', userId);
    if (error) {
      console.error('Error checking pro user status:', error);
      return false;
    }
    return data.length > 0;
  }
  async function getMonthlyTokensUsed(userId) {
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const { data, error } = await supabase.from('parse_coffee_label_invocations').select('tokens_used').eq('user_id', userId).gte('invoked_at', startOfMonth);
    if (error) {
      console.error('Error getting monthly tokens used:', error);
      return 0;
    }
    return data.reduce((acc, row)=>acc + row.tokens_used, 0);
  }
  const proUser = await isProUser(userId);
  const tokenLimit = proUser ? 500 : 10;
  const tokensUsedThisMonth = await getMonthlyTokensUsed(userId);
  const tokensToUse = imagesBase64.length;
  if (tokensUsedThisMonth + tokensToUse > tokenLimit) {
    console.log(`Invocation limit reached for user ${userId}. Tokens used: ${tokensUsedThisMonth}, Tokens to use: ${tokensToUse}, Limit: ${tokenLimit}`);
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
  const processImages = async (base64Images)=>{
    const accessToken = await getAccessToken();
    const requestBody = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: instructions
            },
            ...base64Images.map((base64)=>({
                inlineData: {
                  mimeType: 'image/jpeg',
                  data: base64
                }
              }))
          ]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json"
      }
    };
    const response = await fetch(`https://${geminiRegion}-aiplatform.googleapis.com/v1/projects/${geminiProjectId}/locations/${geminiRegion}/publishers/google/models/gemini-2.0-flash-lite:generateContent`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
    if (!response.ok) {
      const errorMessage = await response.text();
      throw new Error(`Google Gemini API request failed with status ${response.status}: ${errorMessage}`);
    }
    const jsonResponse = await response.json();
    const content = jsonResponse.candidates[0].content.parts[0].text;
    // Log raw content for debugging
    console.log("Raw API response content:", content);
    // Parse the content and check if it is an array
    const parsedContent = JSON.parse(content);
    const result = Array.isArray(parsedContent) ? parsedContent[0] : parsedContent;
    return result;
  };
  try {
    const parsedContent = await processImages(imagesBase64.slice(0, 2));
    // Replace "Unknown" with null
    Object.keys(parsedContent).forEach((key)=>{
      if (parsedContent[key] === "Unknown") {
        parsedContent[key] = null;
      }
    });
    await supabase.from('parse_coffee_label_invocations').insert([
      {
        user_id: userId,
        invoked_at: new Date().toISOString(),
        tokens_used: tokensToUse
      }
    ]);
    return new Response(JSON.stringify(parsedContent), {
      headers: {
        ...cors,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      headers: {
        ...cors,
        'Content-Type': 'application/json'
      }
    });
  }
});
