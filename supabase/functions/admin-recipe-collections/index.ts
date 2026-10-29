import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import OpenAI from "https://esm.sh/openai";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
import {
  CONNECTED_APP_FORBIDDEN_ERROR,
  CONNECTED_APP_FORBIDDEN_MESSAGE,
  isConnectedAppToken,
} from "../_shared/connected-app.ts";
import { createSecureResponse } from "../_shared/security-headers.ts";
import { buildCollectionTranslationMessages } from "./translation-prompt.ts";
import { OPENAI_MODELS } from "../_shared/ai-models.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const openaiApiKey = Deno.env.get("OPENAI_API_KEY_NON_PERSONAL") ?? "";
const OPENAI_MODEL = OPENAI_MODELS.MEDIUM;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

type SupportedLocale = {
  locale: string;
  locale_name: string;
};

type CollectionRow = {
  id: string;
  emoji: string;
  display_order: number;
  is_published: boolean;
  last_modified: string;
};

type LocalizationRow = {
  collection_id: string;
  locale: string;
  name: string;
  description: string | null;
};

type MemberRow = {
  collection_id: string;
  recipe_id: string;
  sort_order: number;
};

type RecipeRow = {
  id: string;
  brewing_method_id: string;
  coffee_amount: number;
  water_amount: number;
  brew_time: number | null;
};

type RecipeLocalizationRow = {
  recipe_id: string;
  name: string;
  short_description: string | null;
};

type CollectionPayload = {
  id: string;
  emoji: string;
  display_order: number;
  is_published: boolean;
  localizations: Array<{
    locale: string;
    name: string;
    description?: string | null;
  }>;
  recipe_ids: string[];
};

type TranslationPayload = {
  source_locale?: string;
  source_name?: string;
  source_description?: string | null;
  target_locales?: string[];
};

const COLLECTION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const LOCALE_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i;

function jsonResponse(
  body: unknown,
  status: number,
  cors: Record<string, string>,
): Response {
  return createSecureResponse(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
    },
  });
}

function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  return token || null;
}

function requireString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} is required`);
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${field} is too long`);
  }
  return trimmed;
}

function requireLocale(value: unknown, field: string): string {
  const locale = requireString(value, field, 12);
  if (!LOCALE_PATTERN.test(locale)) {
    throw new Error(`${field} is invalid`);
  }
  return locale;
}

function optionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new Error(`${field} is too long`);
  }
  return trimmed || null;
}

function parseCollectionPayload(value: unknown): CollectionPayload {
  if (!value || typeof value !== "object") {
    throw new Error("Collection payload is required");
  }

  const body = value as Record<string, unknown>;
  const id = requireString(body.id, "id", 80);
  if (!COLLECTION_ID_PATTERN.test(id)) {
    throw new Error(
      "id must use lowercase letters, numbers, hyphens, and underscores",
    );
  }

  const emoji = requireString(body.emoji, "emoji", 16);
  const displayOrder = Number(body.display_order);
  if (
    !Number.isInteger(displayOrder) || displayOrder < 0 || displayOrder > 10000
  ) {
    throw new Error("display_order must be an integer from 0 to 10000");
  }
  if (typeof body.is_published !== "boolean") {
    throw new Error("is_published must be a boolean");
  }
  if (!Array.isArray(body.localizations) || body.localizations.length === 0) {
    throw new Error("At least one localization is required");
  }
  if (body.localizations.length > 60) {
    throw new Error("Too many localizations");
  }
  if (!Array.isArray(body.recipe_ids)) {
    throw new Error("recipe_ids must be an array");
  }
  if (body.recipe_ids.length > 300) {
    throw new Error("Too many recipes");
  }

  const seenLocales = new Set<string>();
  const localizations = body.localizations.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`localizations[${index}] is invalid`);
    }
    const localization = raw as Record<string, unknown>;
    const locale = requireLocale(
      localization.locale,
      `localizations[${index}].locale`,
    );
    if (seenLocales.has(locale)) {
      throw new Error(`Duplicate locale: ${locale}`);
    }
    seenLocales.add(locale);
    return {
      locale,
      name: requireString(
        localization.name,
        `localizations[${index}].name`,
        160,
      ),
      description: optionalString(
        localization.description,
        `localizations[${index}].description`,
        1200,
      ),
    };
  });

  if (!seenLocales.has("en")) {
    throw new Error("English localization is required");
  }

  const seenRecipeIds = new Set<string>();
  const recipeIds = body.recipe_ids.map((raw, index) => {
    const recipeId = requireString(raw, `recipe_ids[${index}]`, 120);
    if (seenRecipeIds.has(recipeId)) {
      throw new Error(`Duplicate recipe: ${recipeId}`);
    }
    seenRecipeIds.add(recipeId);
    return recipeId;
  });

  return {
    id,
    emoji,
    display_order: displayOrder,
    is_published: body.is_published,
    localizations,
    recipe_ids: recipeIds,
  };
}

function parseTranslationPayload(value: unknown): Required<TranslationPayload> {
  if (!value || typeof value !== "object") {
    throw new Error("Translation payload is required");
  }
  const body = value as Record<string, unknown>;
  const targetLocales = Array.isArray(body.target_locales)
    ? body.target_locales.map((locale, index) =>
      requireLocale(locale, `target_locales[${index}]`)
    )
    : [];

  if (targetLocales.length === 0) {
    throw new Error("target_locales is required");
  }
  if (targetLocales.length > 60) {
    throw new Error("Too many target locales");
  }

  return {
    source_locale: body.source_locale
      ? requireLocale(body.source_locale, "source_locale")
      : "en",
    source_name: requireString(body.source_name, "source_name", 160),
    source_description: optionalString(
      body.source_description,
      "source_description",
      1200,
    ),
    target_locales: [...new Set(targetLocales)],
  };
}

async function requireAdmin(req: Request): Promise<Response | null> {
  const cors = getCorsHeaders(req.headers.get("origin") ?? undefined);
  const token = getBearerToken(req);
  if (!token) {
    return jsonResponse({ error: "Unauthorized" }, 401, cors);
  }

  const { data: userData, error: authError } = await supabase.auth.getUser(
    token,
  );
  if (authError || !userData.user) {
    return jsonResponse(
      { error: "Unauthorized", message: authError?.message ?? "Invalid token" },
      401,
      cors,
    );
  }
  if (isConnectedAppToken(token)) {
    return jsonResponse(
      {
        error: CONNECTED_APP_FORBIDDEN_ERROR,
        message: CONNECTED_APP_FORBIDDEN_MESSAGE,
      },
      403,
      cors,
    );
  }

  const { data: adminData, error: adminError } = await supabase
    .schema("service")
    .from("admin_users")
    .select("role")
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (adminError) {
    return jsonResponse(
      { error: "Admin check failed", message: adminError.message },
      500,
      cors,
    );
  }

  if (adminData?.role !== "admin") {
    return jsonResponse({ error: "Forbidden" }, 403, cors);
  }

  return null;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object"
      ? body as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function loadSupportedLocales(): Promise<SupportedLocale[]> {
  const { data, error } = await supabase
    .from("supported_locales")
    .select("locale, locale_name")
    .order("locale", { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []) as SupportedLocale[];
}

async function loadRecipeOptions() {
  const { data: recipeRows, error: recipesError } = await supabase
    .from("recipes")
    .select("id, brewing_method_id, coffee_amount, water_amount, brew_time")
    .order("brewing_method_id", { ascending: true })
    .order("id", { ascending: true });

  if (recipesError) throw new Error(recipesError.message);
  const recipes = (recipeRows ?? []) as RecipeRow[];
  if (recipes.length === 0) return [];

  const { data: localizationRows, error: localizationsError } = await supabase
    .from("recipe_localization")
    .select("recipe_id, name, short_description")
    .eq("locale", "en")
    .in("recipe_id", recipes.map((recipe) => recipe.id));

  if (localizationsError) throw new Error(localizationsError.message);

  const localizationByRecipeId = new Map(
    ((localizationRows ?? []) as RecipeLocalizationRow[]).map((
      localization,
    ) => [
      localization.recipe_id,
      localization,
    ]),
  );

  return recipes
    .map((recipe) => {
      const localization = localizationByRecipeId.get(recipe.id);
      return {
        id: recipe.id,
        brewing_method_id: recipe.brewing_method_id,
        name: localization?.name ?? recipe.id,
        short_description: localization?.short_description ?? null,
        coffee_amount: recipe.coffee_amount,
        water_amount: recipe.water_amount,
        brew_time: recipe.brew_time,
      };
    })
    .sort((first, second) => first.name.localeCompare(second.name));
}

async function loadCollections() {
  const [collectionsResult, localizationsResult, membersResult] = await Promise
    .all([
      supabase
        .from("recipe_collections")
        .select("id, emoji, display_order, is_published, last_modified")
        .order("display_order", { ascending: true })
        .order("id", { ascending: true }),
      supabase
        .from("recipe_collection_localization")
        .select("collection_id, locale, name, description")
        .order("locale", { ascending: true }),
      supabase
        .from("recipe_collection_members")
        .select("collection_id, recipe_id, sort_order")
        .order("sort_order", { ascending: true }),
    ]);

  if (collectionsResult.error) throw new Error(collectionsResult.error.message);
  if (localizationsResult.error) {
    throw new Error(localizationsResult.error.message);
  }
  if (membersResult.error) throw new Error(membersResult.error.message);

  const localizationsByCollection = new Map<
    string,
    Array<{
      locale: string;
      name: string;
      description: string | null;
    }>
  >();
  ((localizationsResult.data ?? []) as LocalizationRow[]).forEach(
    (localization) => {
      const collectionLocalizations =
        localizationsByCollection.get(localization.collection_id) ?? [];
      collectionLocalizations.push({
        locale: localization.locale,
        name: localization.name,
        description: localization.description,
      });
      localizationsByCollection.set(
        localization.collection_id,
        collectionLocalizations,
      );
    },
  );

  const membersByCollection = new Map<string, MemberRow[]>();
  ((membersResult.data ?? []) as MemberRow[]).forEach((member) => {
    const collectionMembers = membersByCollection.get(member.collection_id) ??
      [];
    collectionMembers.push(member);
    membersByCollection.set(member.collection_id, collectionMembers);
  });

  return ((collectionsResult.data ?? []) as CollectionRow[]).map((
    collection,
  ) => ({
    id: collection.id,
    emoji: collection.emoji,
    display_order: collection.display_order,
    is_published: collection.is_published,
    last_modified: collection.last_modified,
    localizations: localizationsByCollection.get(collection.id) ?? [],
    members: (membersByCollection.get(collection.id) ?? []).map((member) => ({
      recipe_id: member.recipe_id,
      sort_order: member.sort_order,
    })),
  }));
}

async function loadRecipeIds(): Promise<Set<string>> {
  const { data, error } = await supabase.from("recipes").select("id");
  if (error) throw new Error(error.message);
  return new Set(
    ((data ?? []) as Array<{ id: string }>).map((recipe) => recipe.id),
  );
}

function validateReferences(args: {
  payload: CollectionPayload;
  locales: SupportedLocale[];
  recipeIds: Set<string>;
}) {
  const supportedLocales = new Set(args.locales.map((locale) => locale.locale));
  const unsupportedLocales = args.payload.localizations
    .map((localization) => localization.locale)
    .filter((locale) => !supportedLocales.has(locale));
  if (unsupportedLocales.length > 0) {
    throw new Error(`Unsupported locale: ${unsupportedLocales.join(", ")}`);
  }

  const unknownRecipeIds = args.payload.recipe_ids.filter(
    (recipeId) => !args.recipeIds.has(recipeId),
  );
  if (unknownRecipeIds.length > 0) {
    throw new Error(`Unknown recipe: ${unknownRecipeIds.join(", ")}`);
  }
}

async function saveCollection(payload: CollectionPayload, requireNew: boolean) {
  if (requireNew) {
    const { data: existing, error } = await supabase
      .from("recipe_collections")
      .select("id")
      .eq("id", payload.id)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (existing) throw new Error("A collection with this ID already exists");
  }

  const now = new Date().toISOString();
  const { error: collectionError } = await supabase
    .from("recipe_collections")
    .upsert(
      {
        id: payload.id,
        emoji: payload.emoji,
        display_order: payload.display_order,
        is_published: payload.is_published,
        last_modified: now,
      },
      { onConflict: "id" },
    );

  if (collectionError) throw new Error(collectionError.message);

  const { error: deleteLocalizationError } = await supabase
    .from("recipe_collection_localization")
    .delete()
    .eq("collection_id", payload.id);
  if (deleteLocalizationError) throw new Error(deleteLocalizationError.message);

  const { error: insertLocalizationError } = await supabase
    .from("recipe_collection_localization")
    .insert(
      payload.localizations.map((localization) => ({
        collection_id: payload.id,
        locale: localization.locale,
        name: localization.name,
        description: localization.description?.trim() || null,
      })),
    );
  if (insertLocalizationError) throw new Error(insertLocalizationError.message);

  const { error: deleteMembersError } = await supabase
    .from("recipe_collection_members")
    .delete()
    .eq("collection_id", payload.id);
  if (deleteMembersError) throw new Error(deleteMembersError.message);

  if (payload.recipe_ids.length > 0) {
    const { error: insertMembersError } = await supabase
      .from("recipe_collection_members")
      .insert(
        payload.recipe_ids.map((recipeId, index) => ({
          collection_id: payload.id,
          recipe_id: recipeId,
          sort_order: index,
        })),
      );
    if (insertMembersError) throw new Error(insertMembersError.message);
  }

  const savedCollection = (await loadCollections()).find(
    (collection) => collection.id === payload.id,
  );
  if (!savedCollection) {
    throw new Error("Collection was saved but could not be loaded");
  }
  return savedCollection;
}

async function deleteCollection(id: string) {
  if (!COLLECTION_ID_PATTERN.test(id)) {
    throw new Error("Invalid collection ID");
  }

  const { error: membersError } = await supabase
    .from("recipe_collection_members")
    .delete()
    .eq("collection_id", id);
  if (membersError) throw new Error(membersError.message);

  const { error: localizationsError } = await supabase
    .from("recipe_collection_localization")
    .delete()
    .eq("collection_id", id);
  if (localizationsError) throw new Error(localizationsError.message);

  const { error: collectionError } = await supabase
    .from("recipe_collections")
    .delete()
    .eq("id", id);
  if (collectionError) throw new Error(collectionError.message);
}

async function translateCollection(payload: Required<TranslationPayload>) {
  if (!openai) {
    throw new Error("OPENAI_API_KEY_NON_PERSONAL is not configured");
  }

  const locales = await loadSupportedLocales();
  const localeByCode = new Map(
    locales.map((locale) => [locale.locale, locale]),
  );
  const sourceLocale = payload.source_locale;
  const targetLocales = payload.target_locales
    .filter((locale) => locale !== sourceLocale)
    .map((locale) => localeByCode.get(locale))
    .filter((locale): locale is SupportedLocale => Boolean(locale));

  if (targetLocales.length === 0) {
    throw new Error("No supported target locales selected");
  }

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    reasoning_effort: "none",
    response_format: { type: "json_object" },
    messages: buildCollectionTranslationMessages(payload, targetLocales),
  });

  const content = completion.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(content) as {
    translations?: Array<{
      locale?: string;
      name?: string;
      description?: string | null;
    }>;
  };
  const targetLocaleCodes = new Set(
    targetLocales.map((locale) => locale.locale),
  );
  const translations =
    (Array.isArray(parsed.translations) ? parsed.translations : [])
      .filter((translation) =>
        typeof translation.locale === "string" &&
        targetLocaleCodes.has(translation.locale) &&
        typeof translation.name === "string" &&
        translation.name.trim().length > 0
      )
      .map((translation) => ({
        locale: translation.locale as string,
        name: (translation.name as string).trim(),
        description: typeof translation.description === "string"
          ? translation.description.trim()
          : "",
      }));

  if (translations.length === 0) {
    throw new Error("Translation service returned no usable translations");
  }

  return {
    model: OPENAI_MODEL,
    translations,
  };
}

serve(async (req) => {
  const cors = getCorsHeaders(req.headers.get("origin") ?? undefined);

  if (req.method === "OPTIONS") {
    return createSecureResponse("ok", {
      headers: cors,
    });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method Not Allowed" }, 405, cors);
  }

  const authFailure = await requireAdmin(req);
  if (authFailure) {
    return authFailure;
  }

  const body = await readJson(req);
  const action = typeof body.action === "string" ? body.action : "";

  try {
    if (action === "list") {
      const [collections, locales, recipes] = await Promise.all([
        loadCollections(),
        loadSupportedLocales(),
        loadRecipeOptions(),
      ]);

      return jsonResponse(
        {
          collections,
          locales,
          recipes,
          admin_write_configured: true,
        },
        200,
        cors,
      );
    }

    if (action === "create" || action === "update") {
      const payload = parseCollectionPayload(body.collection);
      const [locales, recipeIds] = await Promise.all([
        loadSupportedLocales(),
        loadRecipeIds(),
      ]);
      validateReferences({ payload, locales, recipeIds });
      const collection = await saveCollection(payload, action === "create");
      return jsonResponse({ collection }, 200, cors);
    }

    if (action === "delete") {
      const id = requireString(body.id, "id", 80);
      await deleteCollection(id);
      return jsonResponse({ success: true }, 200, cors);
    }

    if (action === "translate") {
      return jsonResponse(
        await translateCollection(parseTranslationPayload(body.translation)),
        200,
        cors,
      );
    }

    return jsonResponse({ message: "Unknown action" }, 400, cors);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message === "A collection with this ID already exists"
      ? 409
      : 400;
    return jsonResponse({ message }, status, cors);
  }
});
