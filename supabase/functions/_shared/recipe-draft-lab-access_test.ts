import {
  type RecipeDraftLabAccessResult,
  resolveRecipeDraftLabAccess,
} from "./recipe-draft-lab-access.ts";

type Row = Record<string, unknown>;

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `${message}\nExpected: ${expectedJson}\nActual: ${actualJson}`,
    );
  }
}

function createQuery(rows: Row[]) {
  const filters: Array<{ column: string; value: unknown }> = [];

  const query = {
    select() {
      return query;
    },
    eq(column: string, value: unknown) {
      filters.push({
        column,
        value,
      });
      return query;
    },
    maybeSingle<T>() {
      const data = rows.find((row) =>
        filters.every((filter) => row[filter.column] === filter.value)
      );

      return Promise.resolve({
        data: (data ?? null) as T | null,
        error: null,
      });
    },
  };

  return query;
}

function createSupabaseMock(rows: Record<string, Row[]>) {
  return {
    from(table: string) {
      return createQuery(rows[`public.${table}`] ?? []);
    },
    schema(schema: string) {
      return {
        from(table: string) {
          return createQuery(rows[`${schema}.${table}`] ?? []);
        },
      };
    },
  };
}

async function resolve(
  rows: Record<string, Row[]>,
): Promise<RecipeDraftLabAccessResult> {
  return resolveRecipeDraftLabAccess({
    supabase: createSupabaseMock(rows),
    userId: "user-1",
    now: new Date("2026-04-16T12:00:00.000Z"),
  });
}

Deno.test("returns service_admin for users in service.admin_users", async () => {
  const access = await resolve({
    "service.admin_users": [
      {
        user_id: "user-1",
        role: "admin",
      },
    ],
  });

  assertEquals(
    access,
    {
      allowed: true,
      role: "service_admin",
    },
    "Expected service admin access.",
  );
});

Deno.test("returns roaster_admin for users with an active roaster profile", async () => {
  const access = await resolve({
    "public.roaster_profiles": [
      {
        id: "profile-1",
        admin_user_id: "user-1",
        is_active: true,
      },
    ],
  });

  assertEquals(
    access,
    {
      allowed: true,
      role: "roaster_admin",
    },
    "Expected roaster admin access.",
  );
});

Deno.test("returns tester for active unexpired recipe lab access", async () => {
  const access = await resolve({
    "service.recipe_draft_lab_access": [
      {
        user_id: "user-1",
        is_active: true,
        expires_at: "2026-04-17T12:00:00.000Z",
      },
    ],
  });

  assertEquals(
    access,
    {
      allowed: true,
      role: "tester",
    },
    "Expected tester access.",
  );
});

Deno.test("denies inactive tester access", async () => {
  const access = await resolve({
    "service.recipe_draft_lab_access": [
      {
        user_id: "user-1",
        is_active: false,
        expires_at: null,
      },
    ],
  });

  assertEquals(
    access,
    {
      allowed: false,
    },
    "Expected inactive tester access to be denied.",
  );
});

Deno.test("denies expired tester access", async () => {
  const access = await resolve({
    "service.recipe_draft_lab_access": [
      {
        user_id: "user-1",
        is_active: true,
        expires_at: "2026-04-15T12:00:00.000Z",
      },
    ],
  });

  assertEquals(
    access,
    {
      allowed: false,
    },
    "Expected expired tester access to be denied.",
  );
});
