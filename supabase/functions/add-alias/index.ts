import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.42.5';
import { corsHeaders } from '../_shared/cors.ts';
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('Required environment variables are not set');
}
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
Deno.serve(async (req)=>{
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({
      error: 'Method not allowed'
    }), {
      status: 405,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  let body;
  try {
    body = await req.json();
  } catch  {
    return new Response(JSON.stringify({
      error: 'Invalid JSON body'
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  const { roaster_id, alias } = body;
  // Validate and coerce input
  const strRoasterId =
    typeof roaster_id === 'number'
      ? String(roaster_id)
      : typeof roaster_id === 'string'
        ? roaster_id.trim()
        : '';
  if (!strRoasterId) {
    return new Response(JSON.stringify({
      error: 'Missing or invalid roaster_id'
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  const newAlias = typeof alias === 'string' ? alias.trim() : String(alias ?? '').trim();
  if (!newAlias) {
    return new Response(JSON.stringify({
      error: 'Missing or invalid alias'
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  // Get current roaster data
  const { data: roasterData, error: selectError } = await supabase.from('coffee_roasters').select('aliases').eq('id', strRoasterId).single();
  if (selectError || !roasterData) {
    return new Response(JSON.stringify({
      error: selectError?.message ?? 'Roaster not found'
    }), {
      status: 404,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  // Process aliases
  const existing = roasterData.aliases;
  const existingArr = existing ? String(existing).split(',').map(a => a.trim()) : [];
  if (existingArr.map(a => a.toLowerCase()).includes(newAlias.toLowerCase())) {
    return new Response(JSON.stringify({
      error: 'Alias already exists'
    }), {
      status: 409,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  const aliasString = [...existingArr, newAlias].join(',');
  // Update the roaster with new aliases
  const { data, error: updateError } = await supabase.from('coffee_roasters').update({
    aliases: aliasString
  }).eq('id', strRoasterId).select('id, roaster_name, aliases').single();
  if (updateError) {
    return new Response(JSON.stringify({
      error: updateError.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  return new Response(JSON.stringify({
    success: true,
    roaster: data
  }), {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
});
