-- Migration: Roaster Matching Improvements (Phase 1 & 2)
-- Adds potential match detection and vector embedding support

-- ============================================================================
-- PHASE 1: Enhanced Matching for Admin UI
-- ============================================================================

-- 1.1 Add potential_matches column to enrichment results
ALTER TABLE service.roaster_enrichment_results
  ADD COLUMN IF NOT EXISTS potential_matches jsonb DEFAULT '[]';

COMMENT ON COLUMN service.roaster_enrichment_results.potential_matches IS 
  'Array of potential matching roasters for admin review: [{roaster_id, roaster_name, confidence, match_method}]';

-- 1.2 Create function to find potential roaster matches
-- Uses pg_trgm similarity for fuzzy matching
CREATE OR REPLACE FUNCTION public.find_potential_roaster_matches(
  search_normalized_name text,
  search_display_name text,
  max_results int DEFAULT 3,
  min_confidence double precision DEFAULT 0.65
)
RETURNS TABLE(
  roaster_id bigint,
  roaster_name text,
  confidence double precision,
  match_method text
)
LANGUAGE sql
STABLE
AS $function$
  WITH all_matches AS (
    -- Trigram similarity on normalized_name
    SELECT 
      cr.id,
      cr.roaster_name,
      similarity(cr.normalized_name, search_normalized_name) as conf,
      'trigram_normalized'::text as method
    FROM public.coffee_roasters cr
    WHERE similarity(cr.normalized_name, search_normalized_name) >= min_confidence
    
    UNION ALL
    
    -- Trigram on roaster_name
    SELECT 
      cr.id,
      cr.roaster_name,
      similarity(lower(unaccent(cr.roaster_name)), search_normalized_name) as conf,
      'trigram_name'::text as method
    FROM public.coffee_roasters cr
    WHERE similarity(lower(unaccent(cr.roaster_name)), search_normalized_name) >= min_confidence
    
    UNION ALL
    
    -- Alias substring match
    SELECT 
      cr.id,
      cr.roaster_name,
      0.9 as conf,
      'alias_substring'::text as method
    FROM public.coffee_roasters cr
    WHERE cr.normalized_aliases ILIKE '%' || search_normalized_name || '%'
      AND search_normalized_name != ''
    
    UNION ALL
    
    -- Exact normalized name match (highest confidence)
    SELECT 
      cr.id,
      cr.roaster_name,
      0.98 as conf,
      'exact_normalized'::text as method
    FROM public.coffee_roasters cr
    WHERE cr.normalized_name = search_normalized_name
  )
  SELECT DISTINCT ON (id)
    id as roaster_id,
    roaster_name,
    conf as confidence,
    method as match_method
  FROM all_matches
  ORDER BY id, conf DESC
  LIMIT max_results;
$function$;

COMMENT ON FUNCTION public.find_potential_roaster_matches IS 
  'Finds potential matching roasters for a given cluster name using trigram similarity';

-- 1.3 Create view for admin UI to review clusters with potential matches
CREATE OR REPLACE VIEW service.clusters_for_admin_review AS
SELECT 
  rcc.id as cluster_id,
  rcc.normalized_name,
  rcc.display_name,
  rcc.sample_names,
  rcc.candidate_count,
  rcc.occurrences,
  rcc.status,
  rcc.best_match_roaster_id,
  rer.id as enrichment_result_id,
  rer.status as enrichment_status,
  rer.proposed->>'roaster_name' as proposed_name,
  rer.proposed->>'roaster_website_url' as proposed_website,
  rer.proposed->>'country' as proposed_country,
  rer.proposed->>'aliases' as proposed_aliases,
  rer.confidence as enrichment_confidence,
  COALESCE(rer.potential_matches, '[]'::jsonb) as potential_matches,
  rer.signals->'models' as models_used,
  rer.signals->'evidence' as evidence_summary,
  rer.created_at as enriched_at
FROM service.roaster_candidate_clusters rcc
LEFT JOIN service.roaster_enrichment_results rer 
  ON rer.cluster_id = rcc.id
  AND rer.created_at = (
    SELECT MAX(created_at) 
    FROM service.roaster_enrichment_results 
    WHERE cluster_id = rcc.id
  )
WHERE rcc.status = 'pending'
ORDER BY rcc.occurrences DESC, rer.confidence DESC NULLS LAST;

COMMENT ON VIEW service.clusters_for_admin_review IS 
  'View for admin UI to review clusters with enrichment results and potential matches';

-- 1.4 Create RPC to get single cluster details with matches
CREATE OR REPLACE FUNCTION public.get_cluster_with_matches(
  p_cluster_id uuid
)
RETURNS TABLE(
  cluster_id uuid,
  normalized_name text,
  display_name text,
  candidate_count int,
  occurrences int,
  proposed jsonb,
  enrichment_confidence numeric,
  potential_matches jsonb,
  sources jsonb,
  signals jsonb
)
LANGUAGE sql
STABLE
AS $function$
  SELECT 
    rcc.id as cluster_id,
    rcc.normalized_name,
    rcc.display_name,
    rcc.candidate_count,
    rcc.occurrences,
    rer.proposed,
    rer.confidence as enrichment_confidence,
    COALESCE(rer.potential_matches, '[]'::jsonb) as potential_matches,
    rer.sources,
    rer.signals
  FROM service.roaster_candidate_clusters rcc
  LEFT JOIN service.roaster_enrichment_results rer 
    ON rer.cluster_id = rcc.id
  WHERE rcc.id = p_cluster_id
  ORDER BY rer.created_at DESC
  LIMIT 1;
$function$;

COMMENT ON FUNCTION public.get_cluster_with_matches IS 
  'Get detailed cluster information including potential matches for admin review';

-- 1.5 Create enhanced alias addition function with logging
CREATE OR REPLACE FUNCTION public.add_roaster_alias(
  p_roaster_id bigint,
  p_alias text,
  p_source_cluster_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
AS $function$
DECLARE
  current_aliases text;
  new_aliases text;
  normalized_new_aliases text;
BEGIN
  -- Validate inputs
  IF p_roaster_id IS NULL OR p_alias IS NULL OR trim(p_alias) = '' THEN
    RAISE EXCEPTION 'roaster_id and non-empty alias are required';
  END IF;
  
  -- Get current aliases
  SELECT aliases INTO current_aliases
  FROM public.coffee_roasters
  WHERE id = p_roaster_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roaster with id % not found', p_roaster_id;
  END IF;
  
  -- Check if alias already exists
  IF current_aliases ILIKE '%' || trim(p_alias) || '%' THEN
    -- Alias already exists, just mark cluster if provided
    IF p_source_cluster_id IS NOT NULL THEN
      UPDATE service.roaster_candidate_clusters
      SET status = 'processed_as_alias',
          best_match_roaster_id = p_roaster_id,
          updated_at = now()
      WHERE id = p_source_cluster_id;
    END IF;
    RETURN true;
  END IF;
  
  -- Append new alias
  IF current_aliases IS NULL OR current_aliases = '' THEN
    new_aliases := trim(p_alias);
  ELSE
    new_aliases := current_aliases || ', ' || trim(p_alias);
  END IF;
  
  -- Normalize aliases
  normalized_new_aliases := lower(public.unaccent(new_aliases));
  
  -- Update roaster
  UPDATE public.coffee_roasters
  SET aliases = new_aliases,
      normalized_aliases = normalized_new_aliases,
      name_embedding = NULL  -- Trigger re-embedding
  WHERE id = p_roaster_id;
  
  -- If source cluster provided, mark it as processed
  IF p_source_cluster_id IS NOT NULL THEN
    UPDATE service.roaster_candidate_clusters
    SET status = 'processed_as_alias',
        best_match_roaster_id = p_roaster_id,
        updated_at = now()
    WHERE id = p_source_cluster_id;
  END IF;
  
  RETURN true;
END;
$function$;

COMMENT ON FUNCTION public.add_roaster_alias IS 
  'Add an alias to a roaster and optionally mark the source cluster as processed';

-- ============================================================================
-- PHASE 2: Vector Embeddings Support
-- ============================================================================

-- 2.1 Enable pgvector extension (idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- 2.2 Add embedding column to coffee_roasters (384 dimensions for text-embedding-3-small)
ALTER TABLE public.coffee_roasters
  ADD COLUMN IF NOT EXISTS name_embedding vector(384),
  ADD COLUMN IF NOT EXISTS embedding_updated_at timestamptz;

COMMENT ON COLUMN public.coffee_roasters.name_embedding IS 
  '384-dimensional vector embedding of roaster name + aliases using text-embedding-3-small';

-- 2.3 Create HNSW index for fast vector similarity search
-- Only create if embedding column exists and has data
DO $$
BEGIN
  -- Check if index already exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE indexname = 'idx_coffee_roasters_embedding'
  ) THEN
    -- Create index (will be used once embeddings are populated)
    CREATE INDEX idx_coffee_roasters_embedding
      ON public.coffee_roasters
      USING hnsw (name_embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64);
  END IF;
END $$;

COMMENT ON INDEX idx_coffee_roasters_embedding IS 
  'HNSW index for fast cosine similarity search on roaster embeddings';

-- 2.4 Create vector similarity search function
CREATE OR REPLACE FUNCTION public.search_roasters_by_vector(
  query_embedding vector(384),
  match_threshold double precision DEFAULT 0.75,
  match_count int DEFAULT 3
)
RETURNS TABLE(
  roaster_id bigint,
  roaster_name text,
  aliases text,
  similarity_score double precision
)
LANGUAGE sql
STABLE
AS $function$
  SELECT 
    cr.id as roaster_id,
    cr.roaster_name,
    cr.aliases,
    1 - (cr.name_embedding <=> query_embedding) as similarity_score
  FROM public.coffee_roasters cr
  WHERE cr.name_embedding IS NOT NULL
    AND 1 - (cr.name_embedding <=> query_embedding) >= match_threshold
  ORDER BY cr.name_embedding <=> query_embedding
  LIMIT match_count;
$function$;

COMMENT ON FUNCTION public.search_roasters_by_vector IS 
  'Search roasters by vector cosine similarity (requires pre-computed embeddings)';

-- 2.5 Create enhanced matching function that includes vector search
-- This will be used by the enrichment worker after embeddings are populated
CREATE OR REPLACE FUNCTION public.find_potential_roaster_matches_with_vector(
  search_normalized_name text,
  search_display_name text,
  query_embedding vector(384) DEFAULT NULL,
  max_results int DEFAULT 3,
  min_confidence double precision DEFAULT 0.65
)
RETURNS TABLE(
  roaster_id bigint,
  roaster_name text,
  confidence double precision,
  match_method text
)
LANGUAGE sql
STABLE
AS $function$
  WITH all_matches AS (
    -- Vector matches (if embedding provided)
    SELECT 
      v.roaster_id as id,
      v.roaster_name,
      v.similarity_score as conf,
      'vector_cosine'::text as method
    FROM public.search_roasters_by_vector(query_embedding, min_confidence, max_results) v
    WHERE query_embedding IS NOT NULL
    
    UNION ALL
    
    -- Trigram matches (always included)
    SELECT 
      cr.id,
      cr.roaster_name,
      similarity(cr.normalized_name, search_normalized_name) as conf,
      'trigram_normalized'::text as method
    FROM public.coffee_roasters cr
    WHERE similarity(cr.normalized_name, search_normalized_name) >= min_confidence
    
    UNION ALL
    
    SELECT 
      cr.id,
      cr.roaster_name,
      similarity(lower(unaccent(cr.roaster_name)), search_normalized_name) as conf,
      'trigram_name'::text as method
    FROM public.coffee_roasters cr
    WHERE similarity(lower(unaccent(cr.roaster_name)), search_normalized_name) >= min_confidence
    
    UNION ALL
    
    SELECT 
      cr.id,
      cr.roaster_name,
      0.9 as conf,
      'alias_substring'::text as method
    FROM public.coffee_roasters cr
    WHERE cr.normalized_aliases ILIKE '%' || search_normalized_name || '%'
      AND search_normalized_name != ''
    
    UNION ALL
    
    SELECT 
      cr.id,
      cr.roaster_name,
      0.98 as conf,
      'exact_normalized'::text as method
    FROM public.coffee_roasters cr
    WHERE cr.normalized_name = search_normalized_name
  )
  SELECT DISTINCT ON (id)
    id as roaster_id,
    roaster_name,
    conf as confidence,
    method as match_method
  FROM all_matches
  ORDER BY id, conf DESC
  LIMIT max_results;
$function$;

COMMENT ON FUNCTION public.find_potential_roaster_matches_with_vector IS 
  'Finds potential matching roasters using both vector similarity (if available) and trigram matching';

-- 2.6 Create backfill progress tracking table
CREATE TABLE IF NOT EXISTS service.roaster_embedding_backfill (
  roaster_id bigint PRIMARY KEY REFERENCES public.coffee_roasters(id),
  attempted_at timestamptz DEFAULT now(),
  success boolean DEFAULT false,
  error_message text
);

COMMENT ON TABLE service.roaster_embedding_backfill IS 
  'Tracks progress of embedding generation backfill for existing roasters';

-- 2.7 Create function to get roasters needing embeddings (for batch processing)
CREATE OR REPLACE FUNCTION public.get_roasters_needing_embeddings(
  batch_size int DEFAULT 10
)
RETURNS TABLE(
  id bigint,
  roaster_name text,
  aliases text
)
LANGUAGE sql
STABLE
AS $function$
  SELECT 
    cr.id,
    cr.roaster_name,
    cr.aliases
  FROM public.coffee_roasters cr
  LEFT JOIN service.roaster_embedding_backfill reb 
    ON reb.roaster_id = cr.id AND reb.success = true
  WHERE cr.name_embedding IS NULL
    AND reb.roaster_id IS NULL
  ORDER BY cr.id
  LIMIT batch_size;
$function$;

COMMENT ON FUNCTION public.get_roasters_needing_embeddings IS 
  'Get batch of roasters that need embedding generation';

-- 2.8 Create function to record embedding backfill result
CREATE OR REPLACE FUNCTION public.record_embedding_backfill(
  p_roaster_id bigint,
  p_success boolean,
  p_error_message text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO service.roaster_embedding_backfill (roaster_id, success, error_message)
  VALUES (p_roaster_id, p_success, p_error_message)
  ON CONFLICT (roaster_id) 
  DO UPDATE SET 
    attempted_at = now(),
    success = p_success,
    error_message = p_error_message;
END;
$function$;

COMMENT ON FUNCTION public.record_embedding_backfill IS 
  'Record the result of embedding generation attempt for a roaster';

-- 2.9 Create index on normalized_name for fast exact lookups
CREATE INDEX IF NOT EXISTS idx_coffee_roasters_normalized_name
  ON public.coffee_roasters(normalized_name);

-- ============================================================================
-- RLS Policies (if needed)
-- ============================================================================

-- Ensure service schema tables have appropriate policies
-- These should already exist from previous migrations, but included for completeness

-- Enable RLS on new table
ALTER TABLE service.roaster_embedding_backfill ENABLE ROW LEVEL SECURITY;

-- Create policy for service role access
CREATE POLICY service_role_roaster_embedding_backfill 
  ON service.roaster_embedding_backfill 
  FOR ALL 
  TO service_role 
  USING (true) 
  WITH CHECK (true);

-- ============================================================================
-- Migration Complete
-- ============================================================================

-- Add comment to track migration
COMMENT ON TABLE service.roaster_enrichment_results IS 
  'Stores enrichment results with potential_matches column (added 2026-01-27)';
