import {
  buildBatchTranslationMessages,
  buildSingleTranslationMessages,
} from "./translation-prompt.ts";

type TranslationTerm = {
  source: string;
  preferred: string;
};

type BatchPayload = {
  locales: string[];
  text: string;
  terminology_by_locale: Record<string, TranslationTerm[]>;
};

type SinglePayload = {
  locale: string;
  text: string;
  terminology: TranslationTerm[];
};

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}\nExpected: ${expected}\nActual: ${actual}`);
  }
}

function findTerm(
  terms: TranslationTerm[],
  source: string,
): TranslationTerm | undefined {
  return terms.find((term) => term.source === source);
}

Deno.test("batch prompt includes only relevant terminology per locale", () => {
  const text = "Discover the new Brew Diary";
  const locales = ["fr", "de", "unsupported-locale"];
  const messages = buildBatchTranslationMessages(text, locales);

  assertEquals(messages.length, 2, "Batch prompt should contain two messages.");
  assertEquals(
    messages[0].role,
    "system",
    "The first message should contain system instructions.",
  );
  assertEquals(
    messages[1].role,
    "user",
    "The source payload should be a user message.",
  );

  const payload = JSON.parse(messages[1].content) as BatchPayload;
  assertEquals(
    JSON.stringify(payload.locales),
    JSON.stringify(locales),
    "Requested locales should be passed through unchanged.",
  );
  assertEquals(payload.text, text, "Source text should be passed through.");

  const frenchTerm = findTerm(
    payload.terminology_by_locale.fr,
    "Brew Diary",
  );
  const germanTerm = findTerm(
    payload.terminology_by_locale.de,
    "Brew Diary",
  );
  assert(
    frenchTerm !== undefined,
    "French terminology should include Brew Diary.",
  );
  assertEquals(
    frenchTerm?.preferred,
    "Journal de préparation",
    "French should use the ARB-preferred Brew Diary term.",
  );
  assert(
    germanTerm !== undefined,
    "German terminology should include Brew Diary.",
  );
  assertEquals(
    germanTerm?.preferred,
    "Brühtagebuch",
    "German should use the ARB-preferred Brew Diary term.",
  );
  assertEquals(
    payload.terminology_by_locale["unsupported-locale"].length,
    0,
    "Unsupported locales should receive an empty terminology list.",
  );
  assert(
    !payload.terminology_by_locale.fr.some((term) =>
      term.source === "Grind Size"
    ),
    "Unrelated terminology should not be included.",
  );
});

Deno.test("batch and fallback prompts use the same preferred terminology", () => {
  const text = "Discover the new Brew Diary";
  const batchMessages = buildBatchTranslationMessages(text, ["fr"]);
  const singleMessages = buildSingleTranslationMessages(text, "fr");
  const batchPayload = JSON.parse(batchMessages[1].content) as BatchPayload;
  const singlePayload = JSON.parse(singleMessages[1].content) as SinglePayload;

  assertEquals(
    singlePayload.locale,
    "fr",
    "Fallback locale should be preserved.",
  );
  assertEquals(
    singlePayload.text,
    text,
    "Fallback source text should be preserved.",
  );
  assertEquals(
    JSON.stringify(singlePayload.terminology),
    JSON.stringify(batchPayload.terminology_by_locale.fr),
    "Batch and fallback paths should use identical terminology.",
  );
});

Deno.test("prompt retains preservation, grammar, and response-shape instructions", () => {
  const batchSystem = buildBatchTranslationMessages("Text", ["fr"])[0].content;
  const singleSystem = buildSingleTranslationMessages("Text", "fr")[0].content;

  for (
    const requiredInstruction of [
      "naturally and fully",
      "Timer.Coffee",
      "emoji",
      "URLs",
      "markdown link syntax",
      "URL destinations",
      "placeholders",
      "numbers, ratios, and units",
      "Translate markdown link labels",
      "grammatical inflection",
      "translation-memory references",
      "do not introduce their concepts",
      "Return no commentary",
    ]
  ) {
    assert(
      batchSystem.includes(requiredInstruction),
      `Batch system prompt should include "${requiredInstruction}".`,
    );
    assert(
      singleSystem.includes(requiredInstruction),
      `Fallback system prompt should include "${requiredInstruction}".`,
    );
  }

  assert(
    batchSystem.includes('{"translations":{"<locale>":"translated popup"}}'),
    "Batch prompt should retain the translations JSON response contract.",
  );
  assert(
    singleSystem.includes('{"translation":"translated popup"}'),
    "Fallback prompt should require the single-translation JSON contract.",
  );
});

Deno.test("unmatched source retains stable empty terminology shapes", () => {
  const batchMessages = buildBatchTranslationMessages(
    "Zyzzyva quux",
    ["fr"],
  );
  const singleMessages = buildSingleTranslationMessages(
    "Zyzzyva quux",
    "fr",
  );
  const batchPayload = JSON.parse(batchMessages[1].content) as BatchPayload;
  const singlePayload = JSON.parse(singleMessages[1].content) as SinglePayload;

  assertEquals(
    batchPayload.terminology_by_locale.fr.length,
    0,
    "Unmatched batch requests should retain an empty locale list.",
  );
  assertEquals(
    singlePayload.terminology.length,
    0,
    "Unmatched fallback requests should retain an empty terminology list.",
  );
});

// ── Plan 054 Item C — optional per-popup title ──────────────────────────────

Deno.test("untitled prompts are unchanged and carry no title key", () => {
  const batch = buildBatchTranslationMessages("Hello", ["fr"]);
  assert(
    batch[0].content.endsWith(
      'Return ONLY a JSON object of this exact shape: {"translations":{"<locale>":"translated popup"}} with one string entry per requested locale.',
    ),
    "The untitled batch system prompt must be unchanged.",
  );
  assert(
    !batch[0].content.includes("title"),
    "The untitled batch system prompt must not mention a title.",
  );
  assert(
    !("title" in JSON.parse(batch[1].content)),
    "The untitled batch payload must not carry a title key.",
  );

  const single = buildSingleTranslationMessages("Hello", "fr");
  assert(
    single[0].content.endsWith(
      'Return ONLY JSON of this exact shape: {"translation":"translated popup"}.',
    ),
    "The untitled single system prompt must be unchanged.",
  );
  assert(
    !("title" in JSON.parse(single[1].content)),
    "The untitled single payload must not carry a title key.",
  );
});

Deno.test("titled prompts declare the nested shape and pass the title", () => {
  const batch = buildBatchTranslationMessages("Hello", ["fr"], "Coffee Day");
  assert(
    batch[0].content.includes(
      '{"translations":{"<locale>":{"content":"translated popup","title":"translated title"}}}',
    ),
    "The titled batch system prompt must declare the nested shape.",
  );
  const batchPayload = JSON.parse(batch[1].content) as { title?: string };
  assertEquals(
    batchPayload.title,
    "Coffee Day",
    "The titled batch payload must carry the title.",
  );

  const single = buildSingleTranslationMessages("Hello", "fr", "Coffee Day");
  assert(
    single[0].content.includes(
      '{"translation":"translated popup","title":"translated title"}',
    ),
    "The titled single system prompt must declare the nested shape.",
  );
  const singlePayload = JSON.parse(single[1].content) as { title?: string };
  assertEquals(
    singlePayload.title,
    "Coffee Day",
    "The titled single payload must carry the title.",
  );
});
