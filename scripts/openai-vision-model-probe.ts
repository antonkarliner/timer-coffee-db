/**
 * OpenAI vision model probe — mirrors the parse-coffee-label request against
 * the real OpenAI API, to gauge a GPT-5.x-mini swap. Does NOT print the key.
 *
 * Usage:
 *   deno run --allow-env --allow-net --allow-read --env-file=supabase/.env.local \
 *     scripts/openai-vision-model-probe.ts <image-path-or-url> [locale]
 *
 * Notes on GPT-5.x quirks handled here:
 *  - reasoning models only accept default temperature/top_p, so we omit them
 *  - reasoning tokens count against max_completion_tokens, so we budget high
 *    and print usage.reasoning_tokens + finish_reason to catch empty content
 */

const apiKey = Deno.env.get("OPENAI_API_KEY");
if (!apiKey) {
  console.error("OPENAI_API_KEY is not set.");
  Deno.exit(1);
}

const imageArg = Deno.args[0];
const locale = Deno.args[1] ?? "en";
if (!imageArg) {
  console.error("Provide a coffee-label image path or https URL as the first arg.");
  Deno.exit(1);
}

async function toImageUrl(arg: string): Promise<string> {
  if (/^https?:\/\//.test(arg)) return arg;
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

// [label, model, extra body params]
const VARIANTS: [string, string, Record<string, unknown>][] = [
  ["gpt-5.4-mini baseline", "gpt-5.4-mini", { max_completion_tokens: 4096 }],
  ["gpt-5.4-mini + json_object", "gpt-5.4-mini", { max_completion_tokens: 4096, response_format: { type: "json_object" } }],
  ["gpt-5.4-mini + reasoning_effort:low", "gpt-5.4-mini", { max_completion_tokens: 4096, reasoning_effort: "low" }],
];

async function probe(label: string, model: string, extra: Record<string, unknown>) {
  const started = Date.now();
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
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

  let json: any;
  try { json = JSON.parse(text); } catch { console.log("Unexpected envelope:", text.slice(0, 800)); return; }

  const choice = json.choices?.[0];
  const content = choice?.message?.content ?? "";
  console.log(`finish_reason: ${choice?.finish_reason}`);
  console.log(`usage: total=${json.usage?.total_tokens} completion=${json.usage?.completion_tokens} reasoning=${json.usage?.completion_tokens_details?.reasoning_tokens}`);

  const trimmed = content.trim();
  const hasFence = trimmed.includes("```");
  const startsClean = trimmed.startsWith("{");
  let bareParseOk = false;
  let parsed: unknown = null;
  try { parsed = JSON.parse(trimmed); bareParseOk = true; } catch { /* */ }

  console.log(`content empty: ${trimmed.length === 0}`);
  console.log(`starts with "{": ${startsClean}`);
  console.log(`contains code fence: ${hasFence}`);
  console.log(`bare JSON.parse() succeeds (prod path): ${bareParseOk ? "✅ YES" : "❌ NO"}`);
  if (bareParseOk) console.log("parsed fields:", JSON.stringify(parsed, null, 2));
  else console.log("raw content (first 800 chars):\n" + trimmed.slice(0, 800));
}

for (const [label, model, extra] of VARIANTS) {
  try { await probe(label, model, extra); }
  catch (e) { console.log(`\nVARIANT: ${label}\nrequest threw:`, e instanceof Error ? e.message : e); }
}
