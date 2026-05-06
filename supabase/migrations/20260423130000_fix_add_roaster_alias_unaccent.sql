-- Fix add_roaster_alias to use the stable immutable_unaccent wrapper.
-- The unaccent extension lives in the extensions schema in production, so
-- public.unaccent(...) can fail depending on search_path.

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
  IF p_roaster_id IS NULL OR p_alias IS NULL OR trim(p_alias) = '' THEN
    RAISE EXCEPTION 'roaster_id and non-empty alias are required';
  END IF;

  SELECT aliases INTO current_aliases
  FROM public.coffee_roasters
  WHERE id = p_roaster_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roaster with id % not found', p_roaster_id;
  END IF;

  IF current_aliases ILIKE '%' || trim(p_alias) || '%' THEN
    IF p_source_cluster_id IS NOT NULL THEN
      UPDATE service.roaster_candidate_clusters
      SET status = 'processed_as_alias',
          best_match_roaster_id = p_roaster_id,
          updated_at = now()
      WHERE id = p_source_cluster_id;
    END IF;
    RETURN true;
  END IF;

  IF current_aliases IS NULL OR current_aliases = '' THEN
    new_aliases := trim(p_alias);
  ELSE
    new_aliases := current_aliases || ', ' || trim(p_alias);
  END IF;

  normalized_new_aliases := lower(public.immutable_unaccent(new_aliases));

  UPDATE public.coffee_roasters
  SET aliases = new_aliases,
      normalized_aliases = normalized_new_aliases,
      name_embedding = NULL
  WHERE id = p_roaster_id;

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
