import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { resolveCaller } from "../_shared/caller-auth.ts";
import { isConnectedAppToken } from "../_shared/connected-app.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { logError, logInfo, logWarning } from "../_shared/monitoring.ts";
import { createUpdateIdAfterSigninHandler } from "./handler.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error(
    "Supabase URL or Service Role Key is not set in environment variables.",
  );
  Deno.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
const service = supabase.schema("service");
const handler = createUpdateIdAfterSigninHandler({
  resolveCaller: (req) => resolveCaller(req, supabase),
  getSourceUser: async (token) => {
    const { data, error } = await supabase.auth.getUser(token);
    // A connected-app token is not valid proof of the source account.
    if (!error && data.user && isConnectedAppToken(token)) {
      return { data: null, error: { status: 403 } };
    }
    return { data: data.user, error };
  },
  getLedger: async (source, destination) => {
    return await service.from("anonymous_account_migrations").select("status")
      .eq("source_user_id", source).eq("destination_user_id", destination)
      .maybeSingle();
  },
  getOldUser: async (source) => {
    const { data, error } = await supabase.auth.admin.getUserById(source);
    return { data: data.user, error };
  },
  migrate: async (source, destination) => {
    return await service.rpc("migrate_anonymous_account_data", {
      p_source: source,
      p_destination: destination,
    });
  },
  deleteUser: (source) => supabase.auth.admin.deleteUser(source, false),
  complete: async (source, destination) => {
    return await service.rpc("complete_anonymous_account_migration", {
      p_source: source,
      p_destination: destination,
    });
  },
  getCorsHeaders,
  logInfo,
  logWarning,
  logError,
});

serve(handler);
