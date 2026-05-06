export type RecipeDraftLabAccessRole =
  | "service_admin"
  | "roaster_admin"
  | "tester";

export type RecipeDraftLabAccessResult =
  | {
    allowed: true;
    role: RecipeDraftLabAccessRole;
  }
  | {
    allowed: false;
  };

type QueryResult<T> = Promise<{
  data: T | null;
  error: {
    message: string;
  } | null;
}>;

type QueryBuilder = {
  eq(column: string, value: unknown): QueryBuilder;
  maybeSingle<T>(): QueryResult<T>;
};

type SupabaseAccessClient = {
  from(table: string): {
    select(columns: string): QueryBuilder;
  };
  schema(schema: string): {
    from(table: string): {
      select(columns: string): QueryBuilder;
    };
  };
};

type RecipeDraftLabAccessRow = {
  expires_at: string | null;
};

function maybeSingle<T>(query: QueryBuilder): QueryResult<T> {
  return query.maybeSingle<T>();
}

function hasNotExpired(expiresAt: string | null, now: Date) {
  if (!expiresAt) {
    return true;
  }

  const expiry = new Date(expiresAt);
  return Number.isFinite(expiry.getTime()) && expiry > now;
}

export async function resolveRecipeDraftLabAccess(args: {
  supabase: SupabaseAccessClient;
  userId: string;
  now?: Date;
}): Promise<RecipeDraftLabAccessResult> {
  const { supabase, userId, now = new Date() } = args;

  const [
    serviceAdminResult,
    roasterAdminResult,
    testerResult,
  ] = await Promise.all([
    maybeSingle<{ role: string | null }>(
      supabase
        .schema("service")
        .from("admin_users")
        .select("role")
        .eq("user_id", userId),
    ),
    maybeSingle<{ id: string }>(
      supabase
        .from("roaster_profiles")
        .select("id")
        .eq("admin_user_id", userId)
        .eq("is_active", true),
    ),
    maybeSingle<RecipeDraftLabAccessRow>(
      supabase
        .schema("service")
        .from("recipe_draft_lab_access")
        .select("expires_at")
        .eq("user_id", userId)
        .eq("is_active", true),
    ),
  ]);

  if (serviceAdminResult.error) {
    throw new Error(
      `Failed to verify service admin access: ${serviceAdminResult.error.message}`,
    );
  }

  if (roasterAdminResult.error) {
    throw new Error(
      `Failed to verify roaster admin access: ${roasterAdminResult.error.message}`,
    );
  }

  if (testerResult.error) {
    throw new Error(
      `Failed to verify recipe draft lab tester access: ${testerResult.error.message}`,
    );
  }

  if (serviceAdminResult.data?.role) {
    return {
      allowed: true,
      role: "service_admin",
    };
  }

  if (roasterAdminResult.data) {
    return {
      allowed: true,
      role: "roaster_admin",
    };
  }

  if (
    testerResult.data &&
    hasNotExpired(testerResult.data.expires_at, now)
  ) {
    return {
      allowed: true,
      role: "tester",
    };
  }

  return {
    allowed: false,
  };
}
