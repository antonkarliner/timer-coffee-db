import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
import { isConnectedAppToken } from "../_shared/connected-app.ts";
import { createSecureResponse } from "../_shared/security-headers.ts";
import {
  buildWelcomeEmailHtml,
  buildWelcomeEmailSubject,
  buildWelcomeEmailText,
  WELCOME_EMAIL_FROM,
  type WelcomeEmailArgs,
} from "./welcome-email.ts";

type AssignableUserRecord = {
  user_id: string;
  email: string | null;
  provider: string | null;
  has_email_identity: boolean;
  last_sign_in_at: string | null;
  created_at: string | null;
};

type RoasterProfileOwnerState = {
  id: string;
  slug: string;
  roaster_name: string;
  description: string | null;
  admin_user_id: string | null;
  assigned_email: string | null;
};

type AdminCheckResult =
  | { ok: true; userId: string }
  | { ok: false; status: number; error: string };

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY");

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("Missing required Supabase configuration");
}

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  corsHeaders: Record<string, string>,
) {
  return createSecureResponse(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function verifyAdminUser(accessToken: string): Promise<AdminCheckResult> {
  const supabaseUser = createClient(
    supabaseUrl!,
    supabaseAnonKey || supabaseServiceRoleKey!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    },
  );

  const { data: userData, error: userError } = await supabaseUser.auth.getUser(
    accessToken,
  );

  if (userError || !userData.user) {
    return {
      ok: false as const,
      status: 401,
      error: "Unauthorized - Invalid or expired token",
    };
  }

  if (isConnectedAppToken(accessToken)) {
    return {
      ok: false as const,
      status: 403,
      error: "Connected apps can't use this function",
    };
  }

  const userId = userData.user.id;
  const tokenRole = typeof userData.user.app_metadata?.role === "string"
    ? userData.user.app_metadata.role
    : null;

  if (tokenRole === "admin") {
    return {
      ok: true as const,
      userId,
    };
  }

  const adminCheckResponse = await fetch(
    `${supabaseUrl}/functions/v1/check-admin-user`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        apikey: supabaseAnonKey || supabaseServiceRoleKey!,
      },
      body: JSON.stringify({ userId }),
    },
  );

  const adminCheckBody = await adminCheckResponse.json().catch(() => ({}));

  if (!adminCheckResponse.ok) {
    return {
      ok: false as const,
      status: 500,
      error: (adminCheckBody as { error?: string }).error ||
        "Failed to verify admin role",
    };
  }

  if ((adminCheckBody as { role?: string }).role !== "admin") {
    return {
      ok: false as const,
      status: 403,
      error: "Forbidden - Admin role required",
    };
  }

  return {
    ok: true as const,
    userId,
  };
}

async function readRoasterProfileOwnerState(
  roasterProfileId: string,
): Promise<RoasterProfileOwnerState | null> {
  const { data, error } = await supabaseAdmin
    .from("roaster_profiles")
    .select("id, slug, roaster_name, description, admin_user_id")
    .eq("id", roasterProfileId)
    .maybeSingle();

  if (error) {
    throw new Error(`Unable to read roaster profile: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  let assignedEmail: string | null = null;

  if (data.admin_user_id) {
    const { data: currentOwnerData, error: currentOwnerError } =
      await supabaseAdmin.auth.admin
        .getUserById(data.admin_user_id);

    if (currentOwnerError) {
      throw new Error(
        `Unable to load assigned owner: ${currentOwnerError.message}`,
      );
    }

    assignedEmail = currentOwnerData.user?.email ?? null;
  }

  return {
    ...data,
    assigned_email: assignedEmail,
  };
}

async function lookupAssignableUser(
  email: string,
): Promise<AssignableUserRecord | null> {
  const { data, error } = await supabaseAdmin.rpc(
    "admin_lookup_assignable_user_by_email",
    {
      p_email: email,
    },
  );

  if (error) {
    throw new Error(`Unable to look up user: ${error.message}`);
  }

  return (data as AssignableUserRecord | null) ?? null;
}

async function createAssignableUser(
  email: string,
): Promise<AssignableUserRecord> {
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    email_confirm: true,
  });

  if (error) {
    throw new Error(error.message);
  }

  if (!data.user?.id) {
    throw new Error("Supabase user creation returned no user");
  }

  return {
    user_id: data.user.id,
    email: data.user.email ?? email,
    provider: "email",
    has_email_identity: true,
    last_sign_in_at: data.user.last_sign_in_at ?? null,
    created_at: data.user.created_at ?? null,
  };
}

async function assignRoasterOwner(
  roasterProfileId: string,
  adminUserId: string,
) {
  const { error } = await supabaseAdmin.rpc("admin_set_roaster_profile_owner", {
    p_roaster_profile_id: roasterProfileId,
    p_admin_user_id: adminUserId,
  });

  if (error) {
    throw new Error(error.message);
  }
}

// Name from the open or approved claim this email made for the profile, if
// any. Only personalises the welcome email, so a failed lookup is not fatal.
async function lookupClaimantFullName(
  roasterProfileId: string,
  email: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .schema("service")
    .from("roaster_claim_requests")
    .select("email, full_name")
    .eq("roaster_profile_id", roasterProfileId)
    .in("status", ["pending", "approved"])
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    console.warn(`Unable to look up claim request: ${error.message}`);
    return null;
  }

  const claim = (data ?? []).find((row) =>
    typeof row.email === "string" && row.email.trim().toLowerCase() === email
  );

  return claim?.full_name ?? null;
}

async function sendWelcomeEmail(args: WelcomeEmailArgs) {
  if (!resendApiKey) {
    return {
      sent: false,
      message: "RESEND_API_KEY is not configured",
    };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: WELCOME_EMAIL_FROM,
        to: [args.email],
        subject: buildWelcomeEmailSubject(args),
        html: buildWelcomeEmailHtml(args),
        text: buildWelcomeEmailText(args),
      }),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const resendError = payload as {
        error?: {
          message?: string;
        };
        message?: string;
      };

      return {
        sent: false,
        message: resendError.error?.message || resendError.message ||
          "Unable to send welcome email",
      };
    }

    return {
      sent: true,
      message: null,
    };
  } catch (error) {
    return {
      sent: false,
      message: error instanceof Error
        ? error.message
        : "Unable to send welcome email",
    };
  }
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req.headers.get("origin") ?? undefined);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      { error: `Method ${req.method} Not Allowed` },
      405,
      corsHeaders,
    );
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/);

  if (!tokenMatch) {
    return jsonResponse(
      { error: "Unauthorized - Bearer token required" },
      401,
      corsHeaders,
    );
  }

  let adminCheck: AdminCheckResult;

  try {
    adminCheck = await verifyAdminUser(tokenMatch[1]);
  } catch (error) {
    return jsonResponse(
      {
        error: error instanceof Error
          ? error.message
          : "Failed to verify admin role",
      },
      500,
      corsHeaders,
    );
  }

  if (!adminCheck.ok) {
    return jsonResponse(
      { error: adminCheck.error },
      adminCheck.status,
      corsHeaders,
    );
  }

  let body: {
    roasterProfileId?: unknown;
    email?: unknown;
    confirmReplace?: unknown;
    loginUrl?: unknown;
  };

  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
  }

  const roasterProfileId = typeof body.roasterProfileId === "string"
    ? body.roasterProfileId.trim()
    : "";
  const email = typeof body.email === "string"
    ? body.email.trim().toLowerCase()
    : "";
  const confirmReplace = body.confirmReplace === true;
  const loginUrl = typeof body.loginUrl === "string"
    ? body.loginUrl.trim()
    : "";

  if (!isUuid(roasterProfileId)) {
    return jsonResponse(
      { error: "Invalid roaster profile id" },
      400,
      corsHeaders,
    );
  }

  if (!isEmail(email)) {
    return jsonResponse(
      { error: "Enter a valid email address" },
      400,
      corsHeaders,
    );
  }

  try {
    new URL(loginUrl);
  } catch {
    return jsonResponse(
      { error: "Invalid roaster login URL" },
      400,
      corsHeaders,
    );
  }

  try {
    const profile = await readRoasterProfileOwnerState(roasterProfileId);

    if (!profile) {
      return jsonResponse(
        { error: "Roaster profile not found" },
        404,
        corsHeaders,
      );
    }

    let assignableUser = await lookupAssignableUser(email);
    let userExisted = Boolean(assignableUser);

    if (!assignableUser) {
      try {
        assignableUser = await createAssignableUser(email);
        userExisted = false;
      } catch (createError) {
        const fallbackLookup = await lookupAssignableUser(email);

        if (!fallbackLookup) {
          throw createError;
        }

        assignableUser = fallbackLookup;
        userExisted = true;
      }
    }

    if (!assignableUser.has_email_identity) {
      return jsonResponse(
        {
          error:
            "Assigned owner must have a Supabase email identity for roaster OTP login",
        },
        400,
        corsHeaders,
      );
    }

    const replacedExistingOwner = Boolean(
      profile.admin_user_id && profile.admin_user_id !== assignableUser.user_id,
    );

    if (replacedExistingOwner && !confirmReplace) {
      return jsonResponse(
        {
          error:
            "This roaster already has an assigned owner. Confirm replacement to continue.",
          currentOwnerEmail: profile.assigned_email,
        },
        409,
        corsHeaders,
      );
    }

    if (profile.admin_user_id !== assignableUser.user_id) {
      try {
        await assignRoasterOwner(profile.id, assignableUser.user_id);
      } catch (assignmentError) {
        const message = assignmentError instanceof Error
          ? assignmentError.message
          : "Unable to assign roaster owner";
        const status = /email identity|unique|already/i.test(message)
          ? 400
          : 500;

        return jsonResponse({ error: message }, status, corsHeaders);
      }
    }

    const notification = await sendWelcomeEmail({
      email,
      loginUrl,
      roasterName: profile.roaster_name,
      slug: profile.slug,
      claimantFullName: await lookupClaimantFullName(profile.id, email),
      hasDescription: Boolean(profile.description?.trim()),
    });

    return jsonResponse(
      {
        roaster: {
          id: profile.id,
          slug: profile.slug,
          roasterName: profile.roaster_name,
        },
        email,
        userId: assignableUser.user_id,
        userExisted,
        replacedExistingOwner,
        notificationSent: notification.sent,
        notificationMessage: notification.message,
        loginUrl,
      },
      200,
      corsHeaders,
    );
  } catch (error) {
    return jsonResponse(
      {
        error: error instanceof Error
          ? error.message
          : "Unable to onboard roaster admin",
      },
      500,
      corsHeaders,
    );
  }
});
