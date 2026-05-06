import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { getCorsHeaders } from "../_shared/cors.ts";
import { resolveRecipeDraftLabAccess } from "../_shared/recipe-draft-lab-access.ts";
import { createSecureResponse } from "../_shared/security-headers.ts";
import { createCheckRecipeDraftLabAccessHandler } from "./handler.ts";

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

const handler = createCheckRecipeDraftLabAccessHandler({
  async getUserFromToken(token) {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      return null;
    }

    return {
      id: data.user.id,
    };
  },
  async getRecipeDraftLabAccess(userId) {
    return resolveRecipeDraftLabAccess({
      supabase,
      userId,
    });
  },
  getCorsHeaders,
  createResponse(body, init) {
    return createSecureResponse(body, init);
  },
});

serve(handler);
