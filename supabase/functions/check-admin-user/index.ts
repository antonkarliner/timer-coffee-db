import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.42.5';
import { corsHeaders } from '../_shared/cors.ts';
import { createCheckAdminUserHandler } from './handler.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('Required environment variables are not set');
}
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

const handler = createCheckAdminUserHandler({
  async getUserFromToken(token) {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      return null;
    }
    return { id: data.user.id };
  },
  async isAdminUser(userId) {
    const { data, error } = await supabase
      .schema('service')
      .from('admin_users')
      .select('role')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      throw new Error(error.message);
    }
    return Boolean(data?.role);
  },
  corsHeaders,
});

Deno.serve(handler);
