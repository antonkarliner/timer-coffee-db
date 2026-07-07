import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.42.5';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('Required environment variables are not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseBool(value: unknown): boolean | null {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

type RawReviewRow = {
  id: string;
  created_at: string;
  updated_at: string;
  rating: number;
  review_text: string | null;
  is_public: boolean;
  would_buy_again: boolean | null;
  flavor_tags: string[] | null;
  sweetness: number | null;
  acidity: number | null;
  fruitiness: number | null;
  body: number | null;
  bitterness: number | null;
  aftertaste: number | null;
  brewing_method_id: string | null;
  detected_source_locale: string | null;
  bean_name: string;
  roaster_profile_id: string | null;
  user_id: string;
  roaster_name_snapshot: string | null;
  roaster_profile: { slug: string | null; roaster_name: string | null } | null;
  // PostgREST returns an array for one-to-many (review_replies → bean_reviews)
  reply: Array<{ reply_text: string; created_at: string }>;
};

type ReviewerRow = {
  user_id: string;
  display_name: string | null;
  profile_picture_url: string | null;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Validate admin via Bearer token
  const authHeader = req.headers.get('Authorization');
  const token = authHeader?.replace('Bearer ', '').trim();
  if (!token) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized', detail: authError?.message }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { data: adminData, error: adminError } = await supabase
    .schema('service')
    .from('admin_users')
    .select('role')
    .eq('user_id', user.id)
    .single();

  if (adminError || !adminData || adminData.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Parse request body
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // empty body fine — all params have defaults
  }

  const search = typeof body.search === 'string' ? body.search.trim() : '';
  const minRating = parseNumber(body.min_rating);
  const maxRating = parseNumber(body.max_rating);
  const hasReply = parseBool(body.has_reply);
  const isPublic = parseBool(body.is_public);
  const offset = Math.max(0, parseNumber(body.offset) ?? 0);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseNumber(body.limit) ?? DEFAULT_LIMIT));

  // Over-fetch when post-filtering so pagination still has enough rows
  const needsPostFilter = hasReply !== null || search.length > 0;
  const queryLimit = needsPostFilter ? Math.min(MAX_LIMIT, limit * 4) : limit;
  const queryOffset = needsPostFilter ? 0 : offset;

  // Step 1: query bean_reviews with roaster_profiles and review_replies
  // user_public_profiles has no FK to bean_reviews so we fetch it separately
  let query = supabase
    .from('bean_reviews')
    .select(`
      id, created_at, updated_at, rating, review_text, is_public,
      would_buy_again, flavor_tags, sweetness, acidity, fruitiness, body,
      bitterness, aftertaste, brewing_method_id, detected_source_locale,
      bean_name, roaster_profile_id, user_id,
      roaster_name_snapshot:roaster_name,
      roaster_profile:roaster_profiles!bean_reviews_roaster_profile_id_fkey(slug, roaster_name),
      reply:review_replies(reply_text, created_at)
    `)
    .order('created_at', { ascending: false });

  if (minRating !== null) query = query.gte('rating', minRating);
  if (maxRating !== null) query = query.lte('rating', maxRating);
  if (isPublic !== null) query = query.eq('is_public', isPublic);
  query = query.range(queryOffset, queryOffset + queryLimit - 1);

  const { data: reviewData, error: reviewError } = await query.returns<RawReviewRow[]>();

  if (reviewError) {
    console.error('bean_reviews query error:', reviewError.message);
    return new Response(JSON.stringify({ error: reviewError.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const rows = reviewData ?? [];

  // Step 2: fetch reviewer profiles for all unique user_ids
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  let reviewerMap = new Map<string, ReviewerRow>();

  if (userIds.length > 0) {
    const { data: reviewerData, error: reviewerError } = await supabase
      .from('user_public_profiles')
      .select('user_id, display_name, profile_picture_url')
      .in('user_id', userIds)
      .returns<ReviewerRow[]>();

    if (reviewerError) {
      console.error('user_public_profiles query error:', reviewerError.message);
      // Non-fatal: continue without reviewer info
    } else {
      reviewerMap = new Map((reviewerData ?? []).map((r) => [r.user_id, r]));
    }
  }

  // Post-filter: has_reply and search (reply is an array in PostgREST one-to-many)
  const lowerSearch = search.toLowerCase();
  let filtered = rows.filter((row) => {
    const firstReply = row.reply?.[0] ?? null;
    if (hasReply === true && !firstReply) return false;
    if (hasReply === false && firstReply) return false;
    if (lowerSearch.length > 0) {
      const profileName = row.roaster_profile?.roaster_name?.toLowerCase() ?? '';
      const snapshot = row.roaster_name_snapshot?.toLowerCase() ?? '';
      if (!profileName.includes(lowerSearch) && !snapshot.includes(lowerSearch)) {
        return false;
      }
    }
    return true;
  });

  if (needsPostFilter) {
    filtered = filtered.slice(offset, offset + limit);
  }

  const reviews = filtered.map((row) => {
    const reviewer = reviewerMap.get(row.user_id) ?? null;
    const firstReply = row.reply?.[0] ?? null;
    return {
      id: row.id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      rating: row.rating,
      review_text: row.review_text,
      is_public: row.is_public,
      would_buy_again: row.would_buy_again,
      flavor_tags: row.flavor_tags,
      sweetness: row.sweetness,
      acidity: row.acidity,
      fruitiness: row.fruitiness,
      body: row.body,
      bitterness: row.bitterness,
      aftertaste: row.aftertaste,
      brewing_method_id: row.brewing_method_id,
      detected_source_locale: row.detected_source_locale,
      bean_name: row.bean_name,
      roaster_profile_id: row.roaster_profile_id,
      roaster_profile_slug: row.roaster_profile?.slug ?? null,
      roaster_profile_name: row.roaster_profile?.roaster_name ?? null,
      roaster_name_snapshot: row.roaster_name_snapshot ?? '',
      reviewer_user_id: row.user_id,
      reviewer_display_name: reviewer?.display_name ?? null,
      reviewer_avatar_url: reviewer?.profile_picture_url ?? null,
      reply_text: firstReply?.reply_text ?? null,
      reply_created_at: firstReply?.created_at ?? null,
    };
  });

  return new Response(JSON.stringify({ reviews, hasMore: reviews.length === limit }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
