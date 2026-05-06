import { createGeminiModerationClient } from "./moderation-gemini.ts";

export type ModerationResult = { safe: boolean; reason?: string };

type GeminiModerateText = (text: string) => Promise<ModerationResult>;

export type ModerationConfig = {
  openaiApiKey: string;
  groqApiKey?: string;
  cerebrasApiKey?: string;
  geminiServiceAccountKeyJson?: string;
  geminiProjectId?: string;
  geminiRegion?: string;
  fetchImpl?: typeof fetch;
  geminiModerateText?: GeminiModerateText;
};

type SecondaryProviderName = "groq" | "cerebras";

type SecondaryProvider = {
  provider: SecondaryProviderName;
  model: string;
  run: (text: string) => Promise<boolean>;
};

const URL_REGEX = /https?:\/\/|www\.|[a-zA-Z0-9-]+\.(com|net|org|io|co|app|dev|me)\b/i;
const PHONE_REGEX = /\b\+?[\d][\d\s\-().]{5,}\d\b/;

const GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";
const CEREBRAS_CHAT_COMPLETIONS_URL = "https://api.cerebras.ai/v1/chat/completions";

const GROQ_MODELS = [
  "groq/compound-mini",
  "llama-3.1-8b-instant",
] as const;
const CEREBRAS_MODEL = "llama3.1-8b";

function containsObviousLinkOrPhone(text: string): boolean {
  return URL_REGEX.test(text) || PHONE_REGEX.test(text);
}

function hasGeminiConfig(config: ModerationConfig): boolean {
  return Boolean(
    config.geminiServiceAccountKeyJson &&
      config.geminiProjectId &&
      config.geminiRegion,
  );
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }

  return "Unknown error";
}

function buildLinkPhonePrompt(text: string): string {
  const escapedText = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `Analyze this text. Does it contain any URLs, web links (including obfuscated forms like "example dot com"), usernames or handles meant for contact, or phone numbers (including obfuscated forms like "five five five one two three" or "five-oh-three")? Respond ONLY with JSON: {"contains_link_or_phone": true} or {"contains_link_or_phone": false}. Text: "${escapedText}"`;
}

export function createModerationClient(config: ModerationConfig) {
  if (!config.openaiApiKey) {
    throw new Error("Missing OpenAI API key for moderation.");
  }

  const fetchImpl = config.fetchImpl ?? fetch;
  const geminiModerateText: GeminiModerateText | null =
    config.geminiModerateText ??
    (hasGeminiConfig(config)
      ? createGeminiModerationClient({
          serviceAccountKeyJson: config.geminiServiceAccountKeyJson!,
          projectId: config.geminiProjectId!,
          region: config.geminiRegion!,
        }).moderateText
      : null);

  if (!config.groqApiKey && !config.cerebrasApiKey && !geminiModerateText) {
    throw new Error(
      "Missing secondary moderation provider. Configure Groq, Cerebras, or Gemini.",
    );
  }

  async function checkHarmCategories(text: string): Promise<ModerationResult> {
    const response = await fetchImpl("https://api.openai.com/v1/moderations", {
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
      const flaggedCategories = Object.entries(
        result.categories as Record<string, boolean>,
      )
        .filter(([, flagged]) => flagged)
        .map(([cat]) => cat)
        .join(", ");
      return { safe: false, reason: `Content flagged: ${flaggedCategories}` };
    }

    return { safe: true };
  }

  async function runOpenAiCompatibleJsonCheck(args: {
    endpoint: string;
    apiKey: string;
    provider: SecondaryProviderName;
    model: string;
    text: string;
  }): Promise<boolean> {
    const response = await fetchImpl(args.endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: args.model,
        messages: [
          {
            role: "system",
            content:
              "You are a strict moderation classifier. Do not browse, search, or use tools. Return only a JSON object with the key contains_link_or_phone.",
          },
          {
            role: "user",
            content: buildLinkPhonePrompt(args.text),
          },
        ],
        response_format: { type: "json_object" },
        max_completion_tokens: 32,
        temperature: 0,
        stream: false,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.warn(
        `[moderation] ${args.provider}:${args.model} API error ${response.status}: ${errorBody}`,
      );
      throw new Error(`${args.provider}:${args.model} request failed: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (typeof content !== "string" || content.trim().length === 0) {
      console.warn(
        `[moderation] ${args.provider}:${args.model} returned empty content.`,
      );
      throw new Error(`${args.provider}:${args.model} returned empty content`);
    }

    try {
      const parsed = JSON.parse(content);
      return parsed.contains_link_or_phone === true;
    } catch (error) {
      console.warn(
        `[moderation] ${args.provider}:${args.model} returned invalid JSON: ${content}`,
      );
      throw new Error(
        `${args.provider}:${args.model} returned invalid JSON (${summarizeError(error)})`,
      );
    }
  }

  function getSecondaryProviders(): SecondaryProvider[] {
    const providers: SecondaryProvider[] = [];

    if (config.groqApiKey) {
      for (const model of GROQ_MODELS) {
        providers.push({
          provider: "groq",
          model,
          run: (text: string) =>
            runOpenAiCompatibleJsonCheck({
              endpoint: GROQ_CHAT_COMPLETIONS_URL,
              apiKey: config.groqApiKey!,
              provider: "groq",
              model,
              text,
            }),
        });
      }
    }

    if (config.cerebrasApiKey) {
      providers.push({
        provider: "cerebras",
        model: CEREBRAS_MODEL,
        run: (text: string) =>
          runOpenAiCompatibleJsonCheck({
            endpoint: CEREBRAS_CHAT_COMPLETIONS_URL,
            apiKey: config.cerebrasApiKey!,
            provider: "cerebras",
            model: CEREBRAS_MODEL,
            text,
          }),
      });
    }

    return providers;
  }

  async function runSecondaryModeration(text: string): Promise<ModerationResult> {
    const failures: string[] = [];

    for (const provider of getSecondaryProviders()) {
      try {
        console.log(
          `Running secondary moderation with ${provider.provider}:${provider.model}...`,
        );
        const hasObfuscatedLinkOrPhone = await provider.run(text);

        if (hasObfuscatedLinkOrPhone) {
          console.log(
            `Obfuscated link/phone detected by ${provider.provider}:${provider.model}.`,
          );
          return {
            safe: false,
            reason: "Detected obfuscated link or phone number",
          };
        }

        console.log(
          `Link/phone check passed using ${provider.provider}:${provider.model}.`,
        );
        return { safe: true };
      } catch (error) {
        const summary = summarizeError(error);
        failures.push(`${provider.provider}:${provider.model} -> ${summary}`);
        console.warn(
          `[moderation] Secondary provider failed, trying next: ${provider.provider}:${provider.model} (${summary})`,
        );
      }
    }

    if (geminiModerateText) {
      if (failures.length > 0) {
        console.warn("[moderation] Falling back to Gemini after provider failures.", {
          failures,
        });
      } else {
        console.log("[moderation] Using Gemini as the secondary moderation provider.");
      }
      return geminiModerateText(text);
    }

    throw new Error(
      `All secondary moderation providers failed: ${failures.join("; ")}`,
    );
  }

  async function moderateText(text: string): Promise<ModerationResult> {
    if (containsObviousLinkOrPhone(text)) {
      console.log("Link/phone detected by regex pre-filter.");
      return { safe: false, reason: "Detected link or phone number" };
    }

    console.log("Running omni-moderation harm check...");
    const harmResult = await checkHarmCategories(text);
    if (!harmResult.safe) {
      console.log(`omni-moderation flagged content: ${harmResult.reason}`);
      return harmResult;
    }
    console.log("omni-moderation check passed.");

    return runSecondaryModeration(text);
  }

  return { moderateText };
}
