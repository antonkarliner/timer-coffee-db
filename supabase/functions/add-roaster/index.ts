import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.42.5';
import { corsHeaders } from '../_shared/cors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('Required environment variables are not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  let body: { roaster_name?: unknown; roaster_logo_url?: unknown; aliases?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const { roaster_name, roaster_logo_url, aliases } = body;

  // Validate input
  if (
    typeof roaster_name !== 'string' ||
    !roaster_name.trim()
  ) {
    return new Response(
      JSON.stringify({ error: 'Missing or invalid roaster_name' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
  if (
    roaster_logo_url !== undefined &&
    roaster_logo_url !== null &&
    typeof roaster_logo_url !== 'string'
  ) {
    return new Response(
      JSON.stringify({ error: 'roaster_logo_url must be a string or null' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
  if (
    aliases !== undefined &&
    aliases !== null &&
    typeof aliases !== 'string'
  ) {
    return new Response(
      JSON.stringify({ error: 'aliases must be a string or null' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Insert into coffee_roasters
  const insertData = {
    roaster_name: roaster_name.trim(),
    roaster_logo_url: roaster_logo_url === undefined ? null : roaster_logo_url,
    aliases: aliases === undefined ? null : aliases,
  };

  const { data, error } = await supabase
    .from('coffee_roasters')
    .insert([insertData])
    .select('id, roaster_name, roaster_logo_url, aliases')
    .single();

  if (error) {
    // Unique violation (roaster_name)
    if (error.code === '23505') {
      return new Response(
        JSON.stringify({ error: 'Roaster with this name already exists' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({ roaster: data }),
    { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
