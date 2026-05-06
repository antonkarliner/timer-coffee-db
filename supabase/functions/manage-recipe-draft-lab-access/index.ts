import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
import { createSecureResponse } from "../_shared/security-headers.ts";
import { createManageRecipeDraftLabAccessHandler } from "./handler.ts";

type AuthUser = {
  id: string;
  email?: string | null;
};

type AssignableUserRecord = {
  user_id: string;
  email: string | null;
};

type AccessRow = {
  user_id: string;
  role: "tester";
  is_active: boolean;
  expires_at: string | null;
  created_at: string;
  created_by: string | null;
};

const ACCESS_SELECT =
  "user_id, role, is_active, expires_at, created_at, created_by";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

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

async function getUserEmailById(userId: string) {
  const { data, error } = await supabase.auth.admin.getUserById(userId);

  if (error) {
    return null;
  }

  return data.user?.email ?? null;
}

async function withEmail(row: AccessRow) {
  return {
    ...row,
    email: await getUserEmailById(row.user_id),
  };
}

async function resolveAuthUser(identifier: string): Promise<AuthUser | null> {
  const trimmedIdentifier = identifier.trim();

  if (UUID_PATTERN.test(trimmedIdentifier)) {
    const { data, error } = await supabase.auth.admin.getUserById(
      trimmedIdentifier,
    );

    if (error) {
      throw new Error(error.message);
    }

    return data.user;
  }

  const { data, error } = await supabase.rpc(
    "admin_lookup_assignable_user_by_email",
    {
      p_email: trimmedIdentifier,
    },
  );

  if (error) {
    throw new Error(error.message);
  }

  const user = data as AssignableUserRecord | null;
  return user
    ? {
      id: user.user_id,
      email: user.email,
    }
    : null;
}

const handler = createManageRecipeDraftLabAccessHandler({
  async getUserFromToken(token) {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      return null;
    }

    return {
      id: data.user.id,
    };
  },
  async isServiceAdmin(userId) {
    const { data, error } = await supabase
      .schema("service")
      .from("admin_users")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    return Boolean(data?.role);
  },
  async listTesters() {
    const { data, error } = await supabase
      .schema("service")
      .from("recipe_draft_lab_access")
      .select(ACCESS_SELECT)
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(error.message);
    }

    return Promise.all(((data ?? []) as AccessRow[]).map(withEmail));
  },
  async grantTesterAccess({ identifier, expiresAt, createdBy }) {
    const user = await resolveAuthUser(identifier);
    if (!user?.id) {
      return null;
    }

    const { data, error } = await supabase
      .schema("service")
      .from("recipe_draft_lab_access")
      .upsert(
        {
          user_id: user.id,
          role: "tester",
          is_active: true,
          expires_at: expiresAt,
          created_by: createdBy,
        },
        { onConflict: "user_id" },
      )
      .select(ACCESS_SELECT)
      .single();

    if (error) {
      throw new Error(error.message);
    }

    return {
      ...(data as AccessRow),
      email: user.email ?? null,
    };
  },
  async updateTesterAccess({ userId, isActive, expiresAt }) {
    const updates: {
      is_active?: boolean;
      expires_at?: string | null;
    } = {};

    if (typeof isActive === "boolean") {
      updates.is_active = isActive;
    }

    if (expiresAt !== undefined) {
      updates.expires_at = expiresAt;
    }

    const { data, error } = await supabase
      .schema("service")
      .from("recipe_draft_lab_access")
      .update(updates)
      .eq("user_id", userId)
      .select(ACCESS_SELECT)
      .maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    return data ? withEmail(data as AccessRow) : null;
  },
  async getTokenStats(userIds) {
    if (userIds.length === 0) return {};

    const { data, error } = await supabase
      .from("parse_user_recipe_draft_invocations")
      .select("user_id, tokens_used, openai_tokens_used")
      .in("user_id", userIds);

    if (error) throw new Error(error.message);

    const stats: Record<
      string,
      { tokens_used: number; openai_tokens_used: number }
    > = {};
    for (const row of data ?? []) {
      const existing = stats[row.user_id] ??
        { tokens_used: 0, openai_tokens_used: 0 };
      stats[row.user_id] = {
        tokens_used: existing.tokens_used + (row.tokens_used ?? 0),
        openai_tokens_used: existing.openai_tokens_used +
          (row.openai_tokens_used ?? 0),
      };
    }
    return stats;
  },
  async deleteTesterAccess(userId) {
    const { data, error } = await supabase
      .schema("service")
      .from("recipe_draft_lab_access")
      .delete()
      .eq("user_id", userId)
      .select("user_id")
      .maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    return Boolean(data);
  },
  getCorsHeaders,
  createResponse(body, init) {
    return createSecureResponse(body, init);
  },
});

serve(handler);
