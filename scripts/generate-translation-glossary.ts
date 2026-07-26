import {
  TRANSLATION_GLOSSARY_KEY_OVERRIDES,
  TRANSLATION_GLOSSARY_MAX_SOURCE_LENGTH,
  TRANSLATION_GLOSSARY_MIN_SOURCE_LENGTH,
} from "../supabase/functions/_shared/translation-glossary-policy.ts";

export type ArbMessages = Record<string, unknown>;

export type ArbCatalogFile = {
  name: string;
  messages: ArbMessages;
};

export type GlossaryEntry = {
  key: string;
  sourceKeys: string[];
  source: string;
  translations: Record<string, string>;
};

export type ExclusionReason =
  | "sourceNotString"
  | "sourceEmpty"
  | "sourceTooShort"
  | "sourceTooLong"
  | "sourceHasBraces"
  | "localeValueMissing"
  | "targetHasBraces";

export type GlossaryDiagnostics = {
  englishMessageKeyCount: number;
  eligibleKeyCount: number;
  normalizedSourceCount: number;
  ambiguousCollisionCount: number;
  appliedOverrideCount: number;
  exclusionCounts: Record<ExclusionReason, number>;
};

export type GlossaryCatalog = {
  locales: string[];
  entries: GlossaryEntry[];
  diagnostics: GlossaryDiagnostics;
};

export type GeneratedSource = {
  repository: string;
  commit: string;
  arbDirectory: string;
};

type EligibleMessage = {
  key: string;
  source: string;
  translations: Record<string, string>;
};

type GitHubContentItem = {
  name?: unknown;
  type?: unknown;
  download_url?: unknown;
};

const PINNED_SOURCE = {
  repository: "antonkarliner/timer-coffee",
  commit: "f36fb42a76fb3277301ba5451d05f767340b0cde",
  arbDirectory: "lib/l10n",
} as const;

const PINNED_COUNTS = {
  localeCount: 22,
  englishMessageKeyCount: 1_044,
  eligibleKeyCount: 860,
  ambiguousCollisionCount: 32,
  appliedOverrideCount: 7,
  generatedEntryCount: 784,
} as const;

const MAX_GENERATED_BYTES = 1024 * 1024;

function emptyExclusionCounts(): Record<ExclusionReason, number> {
  return {
    sourceNotString: 0,
    sourceEmpty: 0,
    sourceTooShort: 0,
    sourceTooLong: 0,
    sourceHasBraces: 0,
    localeValueMissing: 0,
    targetHasBraces: 0,
  };
}

export function normalizeGlossaryText(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
}

export function localeFromArbFilename(name: string): string | null {
  const match = /^app_([A-Za-z0-9_-]+)\.arb$/u.exec(name);
  if (!match) return null;
  return match[1].replaceAll("_", "-").toLowerCase();
}

function sortedRecord(
  input: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function translationsAgree(messages: EligibleMessage[]): boolean {
  const [first, ...rest] = messages;
  return rest.every((message) =>
    Object.keys(first.translations).every((locale) =>
      normalizeGlossaryText(message.translations[locale]) ===
        normalizeGlossaryText(first.translations[locale])
    )
  );
}

function increment(
  counts: Record<ExclusionReason, number>,
  reason: ExclusionReason,
): void {
  counts[reason] += 1;
}

export function buildGlossaryCatalog(
  files: ArbCatalogFile[],
  overrides: Readonly<Record<string, string>> = {},
): GlossaryCatalog {
  const byLocale = new Map<string, ArbMessages>();
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const locale = localeFromArbFilename(file.name);
    if (!locale) continue;
    if (byLocale.has(locale)) {
      throw new Error(`Duplicate ARB locale: ${locale}`);
    }
    byLocale.set(locale, file.messages);
  }

  const english = byLocale.get("en");
  if (!english) throw new Error("Exactly one app_en.arb file is required");

  const locales = [...byLocale.keys()].sort();
  const targetLocales = locales.filter((locale) => locale !== "en");
  const messageKeys = Object.keys(english)
    .filter((key) => !key.startsWith("@"))
    .sort();
  const exclusions = emptyExclusionCounts();
  const eligible: EligibleMessage[] = [];

  for (const key of messageKeys) {
    const rawSource = english[key];
    if (typeof rawSource !== "string") {
      increment(exclusions, "sourceNotString");
      continue;
    }
    const source = rawSource.trim().replace(/\s+/gu, " ");
    if (!source) {
      increment(exclusions, "sourceEmpty");
      continue;
    }
    const sourceLength = [...source].length;
    if (sourceLength < TRANSLATION_GLOSSARY_MIN_SOURCE_LENGTH) {
      increment(exclusions, "sourceTooShort");
      continue;
    }
    if (sourceLength > TRANSLATION_GLOSSARY_MAX_SOURCE_LENGTH) {
      increment(exclusions, "sourceTooLong");
      continue;
    }
    if (/[{}]/u.test(source)) {
      increment(exclusions, "sourceHasBraces");
      continue;
    }

    const translations: Record<string, string> = {};
    let exclusion: ExclusionReason | null = null;
    for (const locale of targetLocales) {
      const rawTarget = byLocale.get(locale)?.[key];
      if (typeof rawTarget !== "string" || rawTarget.trim() === "") {
        exclusion = "localeValueMissing";
        break;
      }
      const target = rawTarget.trim().replace(/\s+/gu, " ");
      if (/[{}]/u.test(target)) {
        exclusion = "targetHasBraces";
        break;
      }
      translations[locale] = target;
    }
    if (exclusion) {
      increment(exclusions, exclusion);
      continue;
    }
    eligible.push({ key, source, translations: sortedRecord(translations) });
  }

  const groups = new Map<string, EligibleMessage[]>();
  for (const message of eligible) {
    const normalized = normalizeGlossaryText(message.source);
    const group = groups.get(normalized) ?? [];
    group.push(message);
    groups.set(normalized, group);
  }

  const entries: GlossaryEntry[] = [];
  let ambiguousCollisionCount = 0;
  let appliedOverrideCount = 0;
  const usedOverrides = new Set<string>();

  for (
    const normalizedSource of [...groups.keys()].sort((a, b) =>
      a.localeCompare(b)
    )
  ) {
    const group = groups.get(normalizedSource)!.sort((a, b) =>
      a.key.localeCompare(b.key)
    );
    let selected: EligibleMessage | undefined;

    if (group.length === 1 || translationsAgree(group)) {
      selected = group[0];
    } else {
      ambiguousCollisionCount += 1;
      const overrideKey = overrides[normalizedSource];
      if (overrideKey !== undefined) {
        selected = group.find((message) => message.key === overrideKey);
        if (!selected) {
          throw new Error(
            `Stale glossary override for "${normalizedSource}": ` +
              `"${overrideKey}" is not in duplicate group [${
                group.map(({ key }) => key).join(", ")
              }]`,
          );
        }
        usedOverrides.add(normalizedSource);
        appliedOverrideCount += 1;
      }
    }

    if (!selected) continue;
    entries.push({
      key: selected.key,
      sourceKeys: group.map(({ key }) => key).sort(),
      source: selected.source,
      translations: sortedRecord(selected.translations),
    });
  }

  for (const [normalizedSource, overrideKey] of Object.entries(overrides)) {
    if (!usedOverrides.has(normalizedSource)) {
      const keys = groups.get(normalizedSource)?.map(({ key }) => key) ?? [];
      throw new Error(
        `Stale glossary override for "${normalizedSource}": ` +
          `"${overrideKey}" does not select a conflicting duplicate group` +
          (keys.length ? ` [${keys.sort().join(", ")}]` : ""),
      );
    }
  }

  return {
    locales,
    entries,
    diagnostics: {
      englishMessageKeyCount: messageKeys.length,
      eligibleKeyCount: eligible.length,
      normalizedSourceCount: groups.size,
      ambiguousCollisionCount,
      appliedOverrideCount,
      exclusionCounts: exclusions,
    },
  };
}

export function serializeGeneratedModule(
  source: GeneratedSource,
  catalog: GlossaryCatalog,
): string {
  const metadata = {
    repository: source.repository,
    commit: source.commit,
    arbDirectory: source.arbDirectory,
    sourceLocale: "en",
    localeCount: catalog.locales.length,
    eligibleKeyCount: catalog.diagnostics.eligibleKeyCount,
    ambiguousCollisionCount: catalog.diagnostics.ambiguousCollisionCount,
  };
  return [
    "// deno-fmt-ignore-file",
    "// Generated file. Do not edit manually.",
    `export const APP_TERMINOLOGY_SOURCE = ${
      JSON.stringify(metadata, null, 2)
    } as const;`,
    "",
    `export const APP_TERMINOLOGY = ${
      JSON.stringify(catalog.entries, null, 2)
    } as const;`,
    "",
  ].join("\n");
}

export function generatedContentIsCurrent(
  current: string,
  generated: string,
): boolean {
  return current === generated;
}

export function assertPinnedSnapshot(
  source: GeneratedSource,
  catalog: GlossaryCatalog,
): void {
  if (
    source.repository !== PINNED_SOURCE.repository ||
    source.commit !== PINNED_SOURCE.commit ||
    source.arbDirectory !== PINNED_SOURCE.arbDirectory
  ) {
    return;
  }

  const actual = {
    localeCount: catalog.locales.length,
    englishMessageKeyCount: catalog.diagnostics.englishMessageKeyCount,
    eligibleKeyCount: catalog.diagnostics.eligibleKeyCount,
    ambiguousCollisionCount: catalog.diagnostics.ambiguousCollisionCount,
    appliedOverrideCount: catalog.diagnostics.appliedOverrideCount,
    generatedEntryCount: catalog.entries.length,
  };
  for (
    const key of Object.keys(PINNED_COUNTS) as (keyof typeof PINNED_COUNTS)[]
  ) {
    if (actual[key] !== PINNED_COUNTS[key]) {
      throw new Error(
        `Pinned snapshot ${key} drifted: expected ${PINNED_COUNTS[key]}, ` +
          `received ${actual[key]}`,
      );
    }
  }
}

async function githubJson(
  url: string,
  category: "commit" | "list",
  token?: string,
): Promise<unknown> {
  const headers: HeadersInit = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const summary = (await response.text()).slice(0, 300).replace(/\s+/gu, " ");
    throw new Error(
      `GitHub ${category} request failed (${response.status}): ${summary}`,
    );
  }
  return await response.json();
}

async function githubFile(
  url: string,
  token?: string,
): Promise<ArbMessages> {
  const headers: HeadersInit = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const summary = (await response.text()).slice(0, 300).replace(/\s+/gu, " ");
    throw new Error(
      `GitHub file request failed (${response.status}): ${summary}`,
    );
  }
  try {
    return JSON.parse(await response.text()) as ArbMessages;
  } catch (error) {
    throw new Error(
      `GitHub file response was not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function fetchArbCatalog(
  repository: string,
  ref: string,
  arbDirectory: string,
  token?: string,
): Promise<{ commit: string; files: ArbCatalogFile[] }> {
  const repoPath = repository.split("/").map(encodeURIComponent).join("/");
  if (repoPath.split("/").length !== 2) {
    throw new Error("--repo must use the owner/name form");
  }
  const apiBase = `https://api.github.com/repos/${repoPath}`;
  const commitResponse = await githubJson(
    `${apiBase}/commits/${encodeURIComponent(ref)}`,
    "commit",
    token,
  ) as { sha?: unknown };
  if (typeof commitResponse.sha !== "string" || !commitResponse.sha) {
    throw new Error("GitHub commit response did not contain a full SHA");
  }
  const commit = commitResponse.sha;
  const contents = await githubJson(
    `${apiBase}/contents/${
      arbDirectory.split("/").map(encodeURIComponent).join("/")
    }?ref=${encodeURIComponent(commit)}`,
    "list",
    token,
  );
  if (!Array.isArray(contents)) {
    throw new Error("GitHub list response was not an array");
  }
  const selected = (contents as GitHubContentItem[])
    .filter((item) =>
      item.type === "file" &&
      typeof item.name === "string" &&
      localeFromArbFilename(item.name) !== null
    )
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
  if (selected.filter((item) => item.name === "app_en.arb").length !== 1) {
    throw new Error("Exactly one app_en.arb file is required");
  }

  const files = await Promise.all(selected.map(async (item) => {
    if (
      typeof item.name !== "string" ||
      typeof item.download_url !== "string"
    ) {
      throw new Error("GitHub file listing omitted name or download_url");
    }
    return {
      name: item.name,
      messages: await githubFile(item.download_url, token),
    };
  }));
  return { commit, files };
}

type CliOptions = {
  repository: string;
  ref: string;
  arbDirectory: string;
  output: string;
  check: boolean;
};

export function parseCliArgs(args: string[]): CliOptions {
  const values = new Map<string, string>();
  let check = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (!["--repo", "--ref", "--arb-dir", "--output"].includes(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    values.set(arg, value);
    index += 1;
  }
  const repository = values.get("--repo");
  const ref = values.get("--ref");
  const output = values.get("--output");
  if (!repository || !ref || !output) {
    throw new Error("--repo, --ref, and --output are required");
  }
  return {
    repository,
    ref,
    arbDirectory: values.get("--arb-dir") ?? "lib/l10n",
    output,
    check,
  };
}

async function main(): Promise<void> {
  const options = parseCliArgs(Deno.args);
  const token = Deno.env.get("GITHUB_TOKEN");
  const fetched = await fetchArbCatalog(
    options.repository,
    options.ref,
    options.arbDirectory,
    token,
  );
  const source: GeneratedSource = {
    repository: options.repository,
    commit: fetched.commit,
    arbDirectory: options.arbDirectory,
  };
  const catalog = buildGlossaryCatalog(
    fetched.files,
    TRANSLATION_GLOSSARY_KEY_OVERRIDES,
  );
  assertPinnedSnapshot(source, catalog);
  const generated = serializeGeneratedModule(source, catalog);
  const byteSize = new TextEncoder().encode(generated).byteLength;
  if (byteSize >= MAX_GENERATED_BYTES) {
    throw new Error(
      `Generated module is ${byteSize} bytes; limit is below ${MAX_GENERATED_BYTES}`,
    );
  }

  if (options.check) {
    const current = await Deno.readTextFile(options.output);
    if (!generatedContentIsCurrent(current, generated)) {
      console.error(`${options.output} is out of date`);
      Deno.exit(1);
    }
  } else {
    await Deno.writeTextFile(options.output, generated);
  }

  console.log(`Resolved source commit: ${fetched.commit}`);
  console.log(`ARB locales: ${catalog.locales.length}`);
  console.log(
    `English message keys: ${catalog.diagnostics.englishMessageKeyCount}`,
  );
  console.log(`Eligible keys: ${catalog.diagnostics.eligibleKeyCount}`);
  console.log(
    `Ambiguous duplicate-source groups: ` +
      `${catalog.diagnostics.ambiguousCollisionCount}`,
  );
  console.log(
    `Applied overrides: ${catalog.diagnostics.appliedOverrideCount}`,
  );
  console.log(`Generated catalog entries: ${catalog.entries.length}`);
  console.log(`Generated byte size: ${byteSize}`);
  console.log(
    options.check
      ? `${options.output} is up to date`
      : `Wrote ${options.output}`,
  );
}

if (import.meta.main) {
  await main();
}
