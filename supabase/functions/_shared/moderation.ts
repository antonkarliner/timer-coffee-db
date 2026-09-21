/**
 * Text and image moderation for user-submitted content.
 *
 * Pipeline, as of plan 034's held-out evaluation (2026-09-20):
 *
 *   1. **Jev is the primary classifier.** One batched call answers both
 *      questions — `contact` (noul) and `violation` (choice) — against the
 *      same state. When it returns a usable answer, that verdict is final.
 *   2. **Everything else is the offline fallback.** If Jev has no API key,
 *      times out, errors, or answers off-contract, the previous production
 *      chain runs unchanged: regex pre-filter -> omni-moderation harm check
 *      -> secondary link/phone classifier (Groq models, then Gemini).
 *
 * Why this order. On 1,067 scored held-out cases written blind in 17
 * languages (`plans/034-moderation-heldout`, GLM + Codex sets combined),
 * `jev_only` at the thresholds below scored precision 0.988 / recall 0.878 /
 * FPR 0.009. The legacy chain on the same cases scored precision 0.704 /
 * recall 0.755 / FPR 0.274, and it produced 244 errors where Jev produced
 * none. The regex pre-filter contributed false positives and no true
 * positives on the held-out sets, which is why it does NOT gate the Jev
 * path — it survives only inside the fallback, where its cost is paid only
 * when Jev is already unavailable.
 *
 * A rejection has no appeal and the `reason` is shown to the user, so the
 * contact threshold is deliberately high (0.7, not the eval default of 0.5):
 * it drops the held-out false positives from 36 to 5 and costs 9 true
 * positives.
 *
 * `jevAsk` is INJECTED, not imported: jev-client.ts pulls in monitoring.ts,
 * which builds a Supabase client at module load and so requires the core
 * environment variables to exist. Injection keeps this module importable
 * from offline tests and from the evaluation harness. The edge functions
 * wire the real `jevAsk` in; a caller that does not is logged at
 * construction and runs fallback-only.
 */

import { createGeminiModerationClient } from "./moderation-gemini.ts";
import { OPENAI_SPECIALIZED_MODELS } from "./ai-models.ts";
import type {
  JevAskOptions,
  JevChoiceAnswer,
  JevNoulAnswer,
  JevQuestion,
  JevResult,
} from "./jev-client.ts";
import type { Json } from "./types.ts";

export type ModerationResult = { safe: boolean; reason?: string };

type GeminiModerateText = (text: string) => Promise<ModerationResult>;

/** Structural type of `jevAsk`; see the module header for why it is injected. */
export type JevAskFn = (
  state: Json,
  questions: Record<string, JevQuestion>,
  opts?: JevAskOptions,
) => Promise<JevResult | null>;

/** Where the text will be shown. Drives the `where_it_appears` state field. */
export type ModerationSurface = "review" | "recipe" | "display_name" | "wish";

export type ModerationConfig = {
  openaiApiKey: string;
  groqApiKey?: string;
  geminiServiceAccountKeyJson?: string;
  geminiProjectId?: string;
  geminiRegion?: string;
  fetchImpl?: typeof fetch;
  geminiModerateText?: GeminiModerateText;
  /** The real `jevAsk` from _shared/jev-client.ts. Omit to disable Jev. */
  jevAsk?: JevAskFn;
  /**
   * Hard off switch for the primary path even when `jevAsk` is wired, so a
   * cutover can be reverted by flipping one secret. Default true.
   */
  jevEnabled?: boolean;
  /**
   * Per-call deadline for the Jev request. Default 800 ms, matching
   * jev-client's interactive budget: held-out p95 was ~500 ms, so a slower
   * answer than this is better spent on the fallback.
   */
  jevTimeoutMs?: number;
  /** Overrides individual thresholds; unset fields keep the defaults. */
  thresholds?: Partial<ModerationThresholds>;
};

export type ModerateTextOptions = {
  /** Omit when the caller does not know; see `DEFAULT_SURFACE_LABEL`. */
  surface?: ModerationSurface;
  /** Passed through to Jev for request tracing. */
  correlationId?: string;
};

type SecondaryProviderName = "groq";

type SecondaryProvider = {
  provider: SecondaryProviderName;
  model: string;
  run: (text: string) => Promise<boolean>;
};

const URL_REGEX =
  /https?:\/\/|www\.|[a-zA-Z0-9-]+\.(com|net|org|io|co|app|dev|me)\b/i;
const PHONE_REGEX = /\b\+?[\d][\d\s\-().]{5,}\d\b/;

const GROQ_CHAT_COMPLETIONS_URL =
  "https://api.groq.com/openai/v1/chat/completions";

type GroqModel = {
  model: string;
  /** Per-model request fields, merged over the shared request body. */
  requestOverrides: Record<string, unknown>;
};

// gpt-oss always reasons. With the shared 32-token budget, every request came
// back 400 json_validate_failed (6/6, probed 2026-09-19), because the
// reasoning used up the budget before the JSON was written. Low effort plus
// a 256-token cap returned valid JSON 6/6, using 34-52 completion tokens.
// Keep the cap small: Groq's on_demand tier checks prompt +
// max_completion_tokens against an 8,000 TPM per-model ceiling before the
// request runs.
const GROQ_MODELS: readonly GroqModel[] = [
  {
    model: "openai/gpt-oss-20b",
    requestOverrides: { reasoning_effort: "low", max_completion_tokens: 256 },
  },
  { model: "llama-3.1-8b-instant", requestOverrides: {} },
];

// ---------------------------------------------------------------------------
// Jev primary path
// ---------------------------------------------------------------------------

/**
 * Surface descriptions sent as `where_it_appears`. These exact strings were
 * the ones evaluated; changing one invalidates the held-out numbers above.
 */
export const MODERATION_SURFACE_LABEL: Record<ModerationSurface, string> = {
  review: "public review of a coffee bean",
  recipe: "public coffee brewing recipe (name, description, grind, steps)",
  display_name: "public display name of a user profile",
  wish: "New Year greeting sent to a random other user",
};

/**
 * Used when a caller does not say which surface the text belongs to. The
 * `content-moderation` endpoint serves several surfaces behind one payload,
 * and the app does not send the surface today. Unlike the four labels above
 * this one was never in the evaluation, so callers that know their surface
 * should always pass it.
 */
export const DEFAULT_SURFACE_LABEL =
  "public user-submitted text in a coffee app";

/** Choice keys that count as a violation. */
export const MODERATION_VIOLATION_KEYS = [
  "hateful_or_harassing",
  "sexually_explicit",
  "violent_threat_or_graphic",
  "self_harm_or_dangerous",
] as const;

/** Scored separately: the published rules do not mention profanity. */
export const MODERATION_PROFANITY_KEY = "profanity_only";

/**
 * The evaluated prompt. Rubric text mirrors the app's published content
 * rules (`moderationRulesBody`). `scripts/jev-moderation-eval.ts` imports
 * this object so the harness always measures exactly what production sends;
 * editing it invalidates every recorded result.
 */
export const JEV_MODERATION_QUESTIONS: Record<string, JevQuestion> = {
  contact: {
    type: "noul",
    instructions:
      "Does the user-submitted text contain a way to contact someone or visit a site outside the app: a URL or domain, an email address, a phone number, or a social-media or messenger handle or username? Count deliberately obfuscated forms too, such as 'example dot com', 'name at gmail', or digits spelled out as words or split by spaces.",
    criteria: {
      true:
        "Contains a link, domain, email, phone number or contact handle, plain or obfuscated.",
      false:
        "No contact channel. Names of coffee brands, roasters, cafes, farms, places or equipment, and brewing numbers (weights, ratios, times, temperatures, grind settings, dates, batch numbers) are not contact details.",
    },
  },
  violation: {
    type: "choice",
    instructions:
      "Classify the user-submitted text against the app's content rules. Pick the single best option.",
    criteria: {
      acceptable:
        "Allowed. Includes negative or blunt opinions about coffee, products or businesses; coffee jargon that sounds violent or crude (kill the bloom, killer shot, dirty finish, funky, boozy); and ordinary personal names.",
      hateful_or_harassing:
        "Hate speech or slurs against a group, or insults and harassment aimed at a person, including the reader.",
      sexually_explicit: "Sexual content or sexual vulgarity.",
      violent_threat_or_graphic:
        "Threats of violence, or graphic descriptions of violence against people.",
      self_harm_or_dangerous:
        "Encourages self-harm or suicide, or instructs a dangerous activity such as ingesting harmful substances or unsafe doses.",
      [MODERATION_PROFANITY_KEY]:
        "Crude or profane words that do not target any person or group, for example swearing about the coffee itself.",
    },
  },
};

export type ModerationThresholds = {
  /** Block when p(contact) >= this. */
  contact: number;
  /** Block when the summed probability of the violation options >= this. */
  violation: number;
  profanity: "allow" | "block";
};

/**
 * Production defaults. `contact` is 0.7 rather than the eval's 0.5 sweep
 * midpoint: on the combined held-out sets that trades 9 true positives for
 * 31 fewer false blocks, and a false block cannot be appealed. `profanity`
 * stays "allow" because the published rules do not forbid swearing.
 */
export const DEFAULT_MODERATION_THRESHOLDS: ModerationThresholds = {
  contact: 0.7,
  violation: 0.5,
  profanity: "allow",
};

/** User-facing phrasing per violation key; shown verbatim in `reason`. */
const VIOLATION_REASON_LABEL: Record<string, string> = {
  hateful_or_harassing: "hate or harassment",
  sexually_explicit: "sexual content",
  violent_threat_or_graphic: "violence or threats",
  self_harm_or_dangerous: "self-harm or dangerous activity",
  [MODERATION_PROFANITY_KEY]: "profanity",
};

/** The state Jev classifies. One shared object for both questions. */
export type JevModerationState = { where_it_appears: string; text: string };

export function jevModerationState(
  text: string,
  surface?: ModerationSurface,
): JevModerationState {
  return {
    where_it_appears: surface
      ? MODERATION_SURFACE_LABEL[surface]
      : DEFAULT_SURFACE_LABEL,
    text,
  };
}

/**
 * Summed probability mass over the violation options, plus the single
 * heaviest one for the user-facing reason. Identical to the scoring the
 * evaluation harness used.
 */
export function jevViolationMass(
  answer: JevChoiceAnswer,
  profanity: ModerationThresholds["profanity"],
): { mass: number; category: string } {
  const keys: string[] = [...MODERATION_VIOLATION_KEYS];
  if (profanity === "block") keys.push(MODERATION_PROFANITY_KEY);
  let mass = 0;
  let best = "acceptable";
  let bestP = -1;
  for (const key of keys) {
    const p = answer.probabilities[key] ?? 0;
    mass += p;
    if (p > bestP) {
      bestP = p;
      best = key;
    }
  }
  return { mass, category: best };
}

export type JevModerationVerdict = {
  result: ModerationResult;
  contactP: number;
  violationMass: number;
  violationCategory: string;
};

/**
 * Turn one Jev result into a verdict, or `null` when the answers are not
 * the types this module asked for. `null` means "fall back"; it must never
 * be read as "safe".
 */
export function decideFromJev(
  result: JevResult,
  thresholds: ModerationThresholds,
): JevModerationVerdict | null {
  const contact = result.answers.contact as JevNoulAnswer | undefined;
  const violation = result.answers.violation as JevChoiceAnswer | undefined;
  if (contact?.type !== "noul" || violation?.type !== "choice") return null;

  const { mass, category } = jevViolationMass(violation, thresholds.profanity);
  const contactP = contact.noul;

  // Violation is reported first when both trip: it is the more specific and
  // more consequential statement, and it stays true of a text that also
  // carries a link.
  const verdict: ModerationResult = mass >= thresholds.violation
    ? {
      safe: false,
      reason: `Content flagged: ${
        VIOLATION_REASON_LABEL[category] ?? category
      }`,
    }
    : contactP >= thresholds.contact
    ? { safe: false, reason: "Detected link or phone number" }
    : { safe: true };

  return {
    result: verdict,
    contactP,
    violationMass: mass,
    violationCategory: category,
  };
}

// ---------------------------------------------------------------------------
// Fallback path (the pre-2026-09-20 production pipeline, unchanged)
// ---------------------------------------------------------------------------

export function containsObviousLinkOrPhone(text: string): boolean {
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

  // The fallback must stay available even though Jev answers almost every
  // call: it is the only thing standing between a Jev outage and an
  // unmoderated submission.
  if (!config.groqApiKey && !geminiModerateText) {
    throw new Error(
      "Missing secondary moderation provider. Configure Groq or Gemini.",
    );
  }

  const jevEnabled = (config.jevEnabled ?? true) && Boolean(config.jevAsk);
  const jevTimeoutMs = config.jevTimeoutMs ?? 800;
  const thresholds: ModerationThresholds = {
    ...DEFAULT_MODERATION_THRESHOLDS,
    ...config.thresholds,
  };

  if (!jevEnabled) {
    console.warn(
      "[moderation] Jev primary classifier is off; every call uses the legacy fallback.",
      {
        reason: config.jevAsk ? "disabled_by_config" : "jev_ask_not_injected",
      },
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
        model: OPENAI_SPECIALIZED_MODELS.MODERATION,
        input: [{ type: "text", text }],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(
        `omni-moderation API error ${response.status}: ${errorBody}`,
      );
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
    requestOverrides: Record<string, unknown>;
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
        ...args.requestOverrides,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.warn(
        `[moderation] ${args.provider}:${args.model} API error ${response.status}: ${errorBody}`,
      );
      throw new Error(
        `${args.provider}:${args.model} request failed: ${response.status}`,
      );
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
        `${args.provider}:${args.model} returned invalid JSON (${
          summarizeError(error)
        })`,
      );
    }
  }

  function getSecondaryProviders(): SecondaryProvider[] {
    if (!config.groqApiKey) {
      return [];
    }

    return GROQ_MODELS.map(({ model, requestOverrides }) => ({
      provider: "groq" as const,
      model,
      run: (text: string) =>
        runOpenAiCompatibleJsonCheck({
          endpoint: GROQ_CHAT_COMPLETIONS_URL,
          apiKey: config.groqApiKey!,
          provider: "groq",
          model,
          requestOverrides,
          text,
        }),
    }));
  }

  async function runSecondaryModeration(
    text: string,
  ): Promise<ModerationResult> {
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
        console.warn(
          "[moderation] Falling back to Gemini after provider failures.",
          {
            failures,
          },
        );
      } else {
        console.log(
          "[moderation] Using Gemini as the secondary moderation provider.",
        );
      }
      return geminiModerateText(text);
    }

    throw new Error(
      `All secondary moderation providers failed: ${failures.join("; ")}`,
    );
  }

  /**
   * The pipeline that ran in production before Jev. Reached only when the
   * Jev path produced no usable answer. Exported on the client so callers
   * (and tests) can exercise the fallback on its own.
   */
  async function moderateTextLegacy(text: string): Promise<ModerationResult> {
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

  /** One batched Jev call; null on any failure, which means "fall back". */
  async function runJevModeration(
    text: string,
    opts: ModerateTextOptions,
  ): Promise<JevModerationVerdict | null> {
    // jevAsk never throws and returns null on missing key, timeout, non-2xx,
    // or an off-contract body, logging the `jev_fallback` marker itself.
    const result = await config.jevAsk!(
      jevModerationState(text, opts.surface),
      JEV_MODERATION_QUESTIONS,
      {
        timeoutMs: jevTimeoutMs,
        correlationId: opts.correlationId,
      },
    );
    if (!result) return null;

    const verdict = decideFromJev(result, thresholds);
    if (!verdict) {
      console.warn(
        "[moderation] jev_fallback: Jev answered with unexpected answer types.",
        { marker: "jev_fallback", reason: "unexpected_answer_types" },
      );
      return null;
    }
    return verdict;
  }

  async function moderateText(
    text: string,
    opts: ModerateTextOptions = {},
  ): Promise<ModerationResult> {
    if (jevEnabled) {
      const verdict = await runJevModeration(text, opts);
      if (verdict) {
        console.log("[moderation] Jev verdict", {
          safe: verdict.result.safe,
          contact_p: verdict.contactP,
          violation_mass: verdict.violationMass,
          // Only meaningful once the mass crosses the threshold: with no
          // violation probability at all, `category` is just the first key.
          violation_category: verdict.result.safe
            ? undefined
            : verdict.violationCategory,
          surface: opts.surface ?? "unspecified",
        });
        return verdict.result;
      }
      console.warn(
        "[moderation] jev_fallback: running the legacy moderation pipeline.",
        { marker: "jev_fallback", reason: "no_usable_jev_verdict" },
      );
    }

    return moderateTextLegacy(text);
  }

  return { moderateText, moderateTextLegacy };
}
