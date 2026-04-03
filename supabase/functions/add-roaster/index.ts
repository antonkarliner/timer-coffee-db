import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.42.5';
import { corsHeaders } from './_shared/cors.ts';
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('Required environment variables are not set');
}
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
Deno.serve(async (req)=>{
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
  const { roaster_name, roaster_logo_url, roaster_website_url, aliases, city, state, country, address_text, address } = body;
  if (typeof roaster_name !== 'string' || !roaster_name.trim()) {
    return new Response(JSON.stringify({
      error: 'Missing or invalid roaster_name'
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  const stringOrNull = (val)=>val === undefined || val === null || typeof val === 'string';
  if (!stringOrNull(roaster_logo_url)) {
    return new Response(JSON.stringify({
      error: 'roaster_logo_url must be a string or null'
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  if (!stringOrNull(roaster_website_url)) {
    return new Response(JSON.stringify({
      error: 'roaster_website_url must be a string or null'
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  if (!stringOrNull(aliases)) {
    return new Response(JSON.stringify({
      error: 'aliases must be a string or null'
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  if (!stringOrNull(city)) {
    return new Response(JSON.stringify({
      error: 'city must be a string or null'
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  if (!stringOrNull(state)) {
    return new Response(JSON.stringify({
      error: 'state must be a string or null'
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  if (!stringOrNull(country)) {
    return new Response(JSON.stringify({
      error: 'country must be a string or null'
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  const normalizedAddress = address_text ?? address;
  if (!stringOrNull(normalizedAddress)) {
    return new Response(JSON.stringify({
      error: 'address_text must be a string or null'
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  const insertData = {
    roaster_name: roaster_name.trim(),
    roaster_logo_url: roaster_logo_url?.trim() ?? null,
    roaster_website_url: roaster_website_url?.trim() ?? null,
    aliases: aliases?.trim() ?? null,
    city: city?.trim() ?? null,
    state: state?.trim() ?? null,
    country: country?.trim() ?? null,
    address_text: normalizedAddress?.trim() ?? null
  };
  const { data, error } = await supabase.from('coffee_roasters').insert(insertData).select('id, roaster_name, roaster_logo_url, roaster_website_url, aliases, city, state, country, address_text').single();
  if (error) {
    if (error.code === '23505') {
      return new Response(JSON.stringify({
        error: 'Roaster with this name already exists'
      }), {
        status: 409,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  return new Response(JSON.stringify({
    roaster: data
  }), {
    status: 201,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
});
