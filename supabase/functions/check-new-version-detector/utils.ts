import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("Required environment variables are not set");
}
export const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
