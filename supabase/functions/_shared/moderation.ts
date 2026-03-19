export type ModerationResult = { safe: boolean; reason?: string };

export type ModerationConfig = {
  openaiApiKey: string;
  groqApiKey: string;
};

// Regex pre-filter for obvious links and phone numbers
const URL_REGEX = /https?:\/\/|www\.|[a-zA-Z0-9-]+\.(com|net|org|io|co|app|dev|me)\b/i;
const PHONE_REGEX = /\b\+?[\d][\d\s\-().]{5,}\d\b/;

function containsObviousLinkOrPhone(text: string): boolean {
  return URL_REGEX.test(text) || PHONE_REGEX.test(text);
}

export function createModerationClient(config: ModerationConfig) {
  if (!config.openaiApiKey) {
    throw new Error("Missing OpenAI API key for moderation.");
  }
  if (!config.groqApiKey) {
    throw new Error("Missing Groq API key for moderation.");
  }

  async function checkHarmCategories(text: string): Promise<ModerationResult> {
    const response = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "omni-moderation-latest",
        input: [{ type: "text", text }],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`omni-moderation API error ${response.status}: ${errorBody}`);
      throw new Error(`omni-moderation request failed: ${response.status}`);
    }

    const data = await response.json();
    const result = data.results?.[0];

    if (!result) {
      throw new Error("Unexpected omni-moderation response shape.");
    }

    if (result.flagged) {
      const flaggedCategories = Object.entries(result.categories as Record<string, boolean>)
        .filter(([, flagged]) => flagged)
        .map(([cat]) => cat)
        .join(", ");
      return { safe: false, reason: `Content flagged: ${flaggedCategories}` };
    }

    return { safe: true };
  }

  async function checkObfuscatedLinkOrPhone(text: string): Promise<boolean> {
    const prompt = `Analyze this text. Does it contain any URLs, web links (including obfuscated forms like "example dot com"), or phone numbers (including obfuscated forms like "five five five one two three" or "five-oh-three")? Respond ONLY with JSON: {"contains_link_or_phone": true} or {"contains_link_or_phone": false}. Text: "${text.replace(/"/g, '\\"')}"`;

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.groqApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        max_tokens: 20,
        temperature: 0,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`Groq API error ${response.status}: ${errorBody}`);
      throw new Error(`Groq request failed: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      console.warn("Empty Groq response for link/phone check.");
      return false;
    }

    try {
      const parsed = JSON.parse(content);
      return parsed.contains_link_or_phone === true;
    } catch {
      console.warn("Failed to parse Groq link/phone response:", content);
      return false;
    }
  }

  async function moderateText(text: string): Promise<ModerationResult> {
    // Step 1: Regex pre-filter (free, instant)
    if (containsObviousLinkOrPhone(text)) {
      console.log("Link/phone detected by regex pre-filter.");
      return { safe: false, reason: "Detected link or phone number" };
    }

    // Step 2: omni-moderation for harm categories (free, multimodal)
    console.log("Running omni-moderation harm check...");
    const harmResult = await checkHarmCategories(text);
    if (!harmResult.safe) {
      console.log(`omni-moderation flagged content: ${harmResult.reason}`);
      return harmResult;
    }
    console.log("omni-moderation check passed.");

    // Step 3: Groq gpt-oss-20b for obfuscated link/phone detection
    console.log("Running Groq obfuscated link/phone check...");
    const hasObfuscated = await checkObfuscatedLinkOrPhone(text);
    if (hasObfuscated) {
      console.log("Obfuscated link/phone detected by Groq.");
      return { safe: false, reason: "Detected obfuscated link or phone number" };
    }
    console.log("Groq link/phone check passed.");

    return { safe: true };
  }

  return { moderateText };
}
