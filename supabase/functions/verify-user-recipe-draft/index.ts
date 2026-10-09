// This echo stub no longer imports the parser, so paired deployment with parse-user-recipe-draft is unnecessary.
import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
import { createSecureResponse } from "../_shared/security-headers.ts";
import { createVerifyUserRecipeDraftHandler } from "./handler.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    detectSessionInUrl: false,
  },
});

const handler = createVerifyUserRecipeDraftHandler({
  async getUserFromToken(token) {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      return null;
    }

    const user = data.user as typeof data.user & {
      is_anonymous?: boolean;
      app_metadata?: Record<string, unknown>;
    };

    return {
      id: user.id,
      isAnonymous: user.is_anonymous === true ||
        user.app_metadata?.provider === "anonymous",
    };
  },
  getCorsHeaders,
  createResponse(body, init) {
    return createSecureResponse(body, init);
  },
});

serve(handler);
