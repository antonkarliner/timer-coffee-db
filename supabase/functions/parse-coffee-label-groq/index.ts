import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
// Load Groq API key from environment variable
const groqApiKey = Deno.env.get('GROQ_API_KEY');
if (!groqApiKey) {
  console.error("Groq API key is not set in environment variables.");
  Deno.exit(1);
}
const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error("Supabase configuration is not set in environment variables.");
  Deno.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message);
  }
  return 'Unknown error occurred';
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
  const { imagesBase64, ocrText, locale, userId } = body;
  // Detect the current year for more accurate roast date handling.
  const currentYear = new Date().getFullYear();
  // Enhanced system prompt that can handle both images and OCR text
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
    // Add OCR text as additional context if available
    if (ocrText && ocrText.trim().length > 0) {
      basePrompt = `${basePrompt}\n\nAdditional OCR context from mobile device: ${ocrText}`;
    }
    return basePrompt;
  };
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
  const processImagesWithGroq = async (base64Images)=>{
    const systemPrompt = getSystemPrompt(ocrText);
    const messages = [
      {
        role: "system",
        content: systemPrompt
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `locale = ${locale}`
          },
          ...base64Images.map((base64)=>({
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64}`
              }
            }))
        ]
      }
    ];
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${groqApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: "meta-llama/llama-4-scout-17b-16e-instruct",
          messages: messages,
          temperature: 1,
          max_completion_tokens: 1024,
          top_p: 1,
          stream: false
        })
      });
      if (!response.ok) {
        const errorMessage = await response.text();
        throw new Error(`Groq API request failed with status ${response.status}: ${errorMessage}`);
      }
      const jsonResponse = await response.json();
      const content = jsonResponse.choices[0].message.content;
      // Log raw content for debugging
      console.log("Raw Groq API response content:", content);
      // Parse the content and check if it's valid JSON
      let parsedContent;
      try {
        parsedContent = JSON.parse(content);
      } catch (parseError) {
        console.error("Failed to parse Groq response as JSON:", parseError);
        throw new Error(`Invalid JSON response from Groq API: ${content}`);
      }
      // Handle both direct object and array responses
      const result = Array.isArray(parsedContent) ? parsedContent[0] : parsedContent;
      // Replace "Unknown" with null
      if (result && typeof result === 'object') {
        Object.keys(result).forEach((key)=>{
          if (result[key] === "Unknown") {
            result[key] = null;
          }
        });
      }
      return result;
    } catch (error) {
      console.error('Error processing images with Groq:', error);
      throw new Error(getErrorMessage(error));
    }
  };
  try {
    const proUser = await isProUser(userId);
    const tokenLimit = proUser ? 500 : 10;
    const tokensUsedThisMonth = await getMonthlyTokensUsed(userId);
    // Calculate tokens to use (1 token per image)
    const tokensToUse = imagesBase64 ? imagesBase64.length : 1;
    // Handle OCR text only case (no images)
    if (!imagesBase64 || imagesBase64.length === 0) {
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
      // Process OCR text only with Groq
      if (ocrText && ocrText.trim().length > 0) {
        try {
          const systemPrompt = getSystemPrompt(ocrText);
          const messages = [
            {
              role: "system",
              content: systemPrompt
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `locale = ${locale}`
                },
                {
                  type: "text",
                  text: `OCR context from mobile device: ${ocrText}`
                }
              ]
            }
          ];
          const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${groqApiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: "meta-llama/llama-4-scout-17b-16e-instruct",
              messages: messages,
              temperature: 1,
              max_completion_tokens: 1024,
              top_p: 1,
              stream: false
            })
          });
          if (!response.ok) {
            const errorMessage = await response.text();
            throw new Error(`Groq OCR API request failed with status ${response.status}: ${errorMessage}`);
          }
          const jsonResponse = await response.json();
          const content = jsonResponse.choices[0].message.content;
          console.log("Raw Groq OCR response content:", content);
          let parsedContent;
          try {
            parsedContent = JSON.parse(content);
          } catch (parseError) {
            console.error("Failed to parse Groq OCR response as JSON:", parseError);
            throw new Error(`Invalid JSON response from Groq OCR API: ${content}`);
          }
          const result = Array.isArray(parsedContent) ? parsedContent[0] : parsedContent;
          // Replace "Unknown" with null
          if (result && typeof result === 'object') {
            Object.keys(result).forEach((key)=>{
              if (result[key] === "Unknown") {
                result[key] = null;
              }
            });
          }
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
          console.error('Error processing OCR text with Groq:', error);
          throw new Error(getErrorMessage(error));
        }
      } else {
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
    }
    // Process images with Groq
    const parsedContent = await processImagesWithGroq(imagesBase64.slice(0, 2));
    // Log the invocation for tracking
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
      error: getErrorMessage(error)
    }), {
      headers: {
        ...cors,
        'Content-Type': 'application/json'
      }
    });
  }
});
