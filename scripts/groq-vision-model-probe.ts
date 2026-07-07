/**
 * Groq vision model probe — compare a candidate model against the current one
 * using the EXACT request shape parse-coffee-label uses, without touching prod.
 *
 * Usage:
 *   GROQ_API_KEY=... deno run --allow-env --allow-net --allow-read \
 *     scripts/groq-vision-model-probe.ts <image-path-or-url> [locale]
 *
 * Or put GROQ_API_KEY in .env.local and run with --env-file=.env.local.
 *
 * It does NOT print your API key.
 */

// [label, model, extra body params]
const MODELS: [string, string, Record<string, unknown>][] = [
  ["qwen + reasoning_format:hidden", "qwen/qwen3.6-27b", { reasoning_format: "hidden" }],
  ["qwen + hidden + json_object", "qwen/qwen3.6-27b", { reasoning_format: "hidden", response_format: { type: "json_object" } }],
];
// Qwen free tier is 8000 TPM and each vision call ~3.8k tokens; pace the calls.
const DELAY_MS = 35000;

const groqApiKey = Deno.env.get("GROQ_API_KEY");
if (!groqApiKey) {
  console.error("GROQ_API_KEY is not set. Put it in .env.local or the shell env.");
  Deno.exit(1);
}

const imageArg = Deno.args[0];
const locale = Deno.args[1] ?? "en";
if (!imageArg) {
  console.error("Provide a coffee-label image path or https URL as the first arg.");
  Deno.exit(1);
}

// Build the same data:image/jpeg;base64 URL the function sends.
async function toImageUrl(arg: string): Promise<string> {
  if (/^https?:\/\//.test(arg)) return arg; // Groq accepts URL images directly
  const bytes = await Deno.readFile(arg);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const b64 = btoa(binary);
  const ext = arg.split(".").pop()?.toLowerCase();
  const mime = ext === "png" ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${b64}`;
}

const currentYear = new Date().getFullYear();
const systemPrompt =
  `Extract the following fields from the image and respond in JSON format as a single JSON object (do not return an array). If there are multiple images, combine the info into one response. Translate suitable fields to ${locale}. Only respond with valid JSON. No code blocks, no backticks. If there are upper case values, convert them to capitalized case. Use the following JSON structure:
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

const imageUrl = await toImageUrl(imageArg);

async function probe(label: string, model: string, extra: Record<string, unknown>) {
  const started = Date.now();
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${groqApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: `locale = ${locale}` },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
      temperature: 1,
      max_completion_tokens: 1024,
      top_p: 1,
      stream: false,
      ...extra,
    }),
  });
  const ms = Date.now() - started;

  console.log("\n========================================");
  console.log(`VARIANT: ${label}  [${model}]`);
  console.log(`HTTP ${res.status} ${res.statusText}  (${ms} ms)`);

  const text = await res.text();
  if (!res.ok) {
    console.log("ERROR body:", text.slice(0, 800));
    return;
  }

  let content = "";
  try {
    content = JSON.parse(text).choices[0].message.content;
  } catch {
    console.log("Unexpected envelope:", text.slice(0, 800));
    return;
  }

  const trimmed = content.trim();
  const hasFence = trimmed.includes("```");
  const hasThink = /<think>/i.test(trimmed);
  const startsClean = trimmed.startsWith("{");

  // This is the SAME bare parse parse-coffee-label-groq relies on (no fence-strip).
  let bareParseOk = false;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(trimmed);
    bareParseOk = true;
  } catch { /* leaves bareParseOk false */ }

  console.log(`starts with "{": ${startsClean}`);
  console.log(`contains code fence: ${hasFence}`);
  console.log(`contains <think>: ${hasThink}`);
  console.log(`bare JSON.parse() succeeds (prod path): ${bareParseOk ? "✅ YES" : "❌ NO"}`);
  if (bareParseOk) {
    console.log("parsed fields:", JSON.stringify(parsed, null, 2));
  } else {
    console.log("raw content (first 800 chars):\n" + trimmed.slice(0, 800));
  }
}

for (let i = 0; i < MODELS.length; i++) {
  const [label, model, extra] = MODELS[i];
  try {
    await probe(label, model, extra);
  } catch (e) {
    console.log(`\nVARIANT: ${label}\nrequest threw:`, e instanceof Error ? e.message : e);
  }
  if (i < MODELS.length - 1) {
    console.log(`\n…waiting ${DELAY_MS / 1000}s to respect Qwen TPM limit…`);
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }
}
