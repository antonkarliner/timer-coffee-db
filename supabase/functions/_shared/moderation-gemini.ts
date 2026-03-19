export type GeminiModerationResult = { safe: boolean; reason?: string };

export type GeminiModerationConfig = {
  serviceAccountKeyJson: string;
  projectId: string;
  region: string;
};

interface GeminiSafetyRating {
  category: string;
  probability: string;
  blocked?: boolean;
}

interface GeminiPromptFeedback {
  blockReason?: string;
  safetyRatings?: GeminiSafetyRating[];
}

interface GeminiContentPart {
  text?: string;
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

interface ExplicitCheckResponseJson {
  is_problematic: boolean;
  reason: string;
}

const GEMINI_MODEL = "gemini-2.5-flash-lite";

export function createGeminiModerationClient(config: GeminiModerationConfig) {
  if (!config.serviceAccountKeyJson) {
    throw new Error("Missing service account JSON for Gemini moderation.");
  }
  if (!config.projectId) {
    throw new Error("Missing Gemini project ID for moderation.");
  }
  if (!config.region) {
    throw new Error("Missing Gemini region for moderation.");
  }

  const serviceAccount = JSON.parse(config.serviceAccountKeyJson);
  const geminiProjectId = config.projectId;
  const geminiRegion = config.region;

  async function getAccessToken(): Promise<string> {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    const exp = iat + 3600;
    const payload = {
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      exp,
      iat,
    };

    const jwtHeader = { alg: "RS256", typ: "JWT" };

    const encodeBase64Url = (str: string | ArrayBuffer): string => {
      let base64 = "";
      if (typeof str === "string") {
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
    const pemContents = pem
      .substring(pemHeader.length, pem.length - pemFooter.length - 1)
      .replace(/\s+/g, "");
    const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

    try {
      return await crypto.subtle.importKey(
        "pkcs8",
        binaryDer,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        true,
        ["sign"]
      );
    } catch (e) {
      console.error("Error importing private key:", e);
      throw new Error("Failed to import private key.");
    }
  }

  async function callGeminiApi(accessToken: string, requestBody: object): Promise<GeminiApiResponse> {
    const apiUrl = `https://${geminiRegion}-aiplatform.googleapis.com/v1/projects/${geminiProjectId}/locations/${geminiRegion}/publishers/google/models/${GEMINI_MODEL}:generateContent`;

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`Gemini API request failed with status ${response.status}: ${errorBody}`);
      throw new Error(`Gemini API request failed: ${response.status}`);
    }

    return await response.json();
  }

  async function moderateText(text: string): Promise<GeminiModerationResult> {
    const accessToken = await getAccessToken();

    const safetySettings = [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_LOW_AND_ABOVE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_LOW_AND_ABOVE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
    ];

    const safetyCheckRequestBody = {
      contents: [{ role: "user", parts: [{ text }] }],
      safetySettings,
      generationConfig: { maxOutputTokens: 1 },
    };

    console.log("Performing initial safety check...");
    const safetyCheckResponse = await callGeminiApi(accessToken, safetyCheckRequestBody);

    const promptFeedback: GeminiPromptFeedback | undefined = safetyCheckResponse.promptFeedback;
    if (promptFeedback?.blockReason) {
      const blockedCategories = promptFeedback.safetyRatings
        ?.filter((rating: GeminiSafetyRating) => rating.blocked)
        .map((rating: GeminiSafetyRating) => rating.category.replace("HARM_CATEGORY_", ""))
        .join(", ");
      const reason = `Content blocked due to safety settings: ${promptFeedback.blockReason}${blockedCategories ? ` (${blockedCategories})` : ""}`;
      console.log(`Safety check failed: ${reason}`);
      return { safe: false, reason };
    }

    console.log("Initial safety check passed.");
    console.log("Performing link/phone number detection check...");

    const linkCheckPrompt = `Analyze the following text. Does it contain any URLs, web links (including obfuscated forms like 'example dot com'), or phone numbers (including variations like '555-one-two-three-four')? Respond ONLY with valid JSON containing a single key \"contains_link_or_phone\" which is a boolean (true or false). Do not add any other text or explanations. Text: \"${text}\"`;
    const linkCheckRequestBody = {
      contents: [{ role: "user", parts: [{ text: linkCheckPrompt }] }],
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
      ],
      generationConfig: {
        responseMimeType: "application/json",
      },
    };

    const linkCheckResponse = await callGeminiApi(accessToken, linkCheckRequestBody);

    let containsLinkOrPhone = false;
    try {
      if (
        linkCheckResponse.candidates &&
        linkCheckResponse.candidates.length > 0 &&
        linkCheckResponse.candidates[0].content?.parts?.length > 0 &&
        linkCheckResponse.candidates[0].content.parts[0].text
      ) {
        const responseText = linkCheckResponse.candidates[0].content.parts[0].text;
        console.log("Raw link/phone check response text:", responseText);
        const parsedJson: LinkCheckResponseJson = JSON.parse(responseText);
        if (typeof parsedJson.contains_link_or_phone === "boolean") {
          containsLinkOrPhone = parsedJson.contains_link_or_phone;
        } else {
          console.warn("Link/phone check response JSON did not contain a boolean 'contains_link_or_phone' key:", parsedJson);
        }
      } else {
        console.warn("Link/phone check response structure unexpected or empty:", JSON.stringify(linkCheckResponse, null, 2));
      }
    } catch (e) {
      console.error("Error parsing link/phone check JSON response:", e instanceof Error ? e.message : String(e));
    }

    if (containsLinkOrPhone) {
      const reason = "Detected potential link or phone number";
      console.log(`Link/phone check failed: ${reason}`);
      return { safe: false, reason };
    }

    console.log("Link/phone number check passed.");
    console.log("Performing explicit high-sensitivity check...");

    const explicitCheckResponseFormat = "Respond ONLY with valid JSON containing two keys: \\\"is_problematic\\\" (boolean: true if any problematic content is found, false otherwise) and \\\"reason\\\" (string: a brief explanation if problematic, or 'None' if not).";
    const explicitCheckPrompt = `Critically evaluate the following text with maximum sensitivity. Does it contain any form of obscenity, hate speech, harassment, sexually explicit material, or dangerous content, even if subtle or implied? ${explicitCheckResponseFormat} Text: \"${text}\"`;

    const explicitCheckRequestBody = {
      contents: [{ role: "user", parts: [{ text: explicitCheckPrompt }] }],
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
      ],
      generationConfig: {
        responseMimeType: "application/json",
      },
    };

    const explicitCheckResponse = await callGeminiApi(accessToken, explicitCheckRequestBody);

    let isProblematic = false;
    let problematicReason = "Evaluation error";

    try {
      if (
        explicitCheckResponse.candidates &&
        explicitCheckResponse.candidates.length > 0 &&
        explicitCheckResponse.candidates[0].content?.parts?.length > 0 &&
        explicitCheckResponse.candidates[0].content.parts[0].text
      ) {
        const responseText = explicitCheckResponse.candidates[0].content.parts[0].text;
        console.log("Raw explicit check response text:", responseText);
        const parsedJson: ExplicitCheckResponseJson = JSON.parse(responseText);
        if (typeof parsedJson.is_problematic === "boolean") {
          isProblematic = parsedJson.is_problematic;
          problematicReason = parsedJson.reason || (isProblematic ? "Problematic content detected" : "None");
        } else {
          console.warn("Explicit check response JSON did not contain a boolean 'is_problematic' key:", parsedJson);
          isProblematic = true;
          problematicReason = "Invalid format in evaluation response";
        }
      } else {
        console.warn("Explicit check response structure unexpected or empty:", JSON.stringify(explicitCheckResponse, null, 2));
        isProblematic = true;
        problematicReason = "Malformed response from evaluation model";
      }
    } catch (e) {
      console.error("Error parsing explicit check JSON response:", e instanceof Error ? e.message : String(e));
      isProblematic = true;
      problematicReason = "Error parsing evaluation response";
    }

    if (isProblematic) {
      console.log(`Explicit check failed: ${problematicReason}`);
      return { safe: false, reason: `Explicit check: ${problematicReason}` };
    }

    console.log("Explicit high-sensitivity check passed.");
    return { safe: true };
  }

  return { moderateText };
}
