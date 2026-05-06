-- Enable RLS on live_activity tables (edge functions use service_role which bypasses RLS)
ALTER TABLE service.live_activity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE service.live_activity_sessions ENABLE ROW LEVEL SECURITY;

-- Fix clusters_for_admin_review: remove implicit SECURITY DEFINER by recreating with SECURITY INVOKER
CREATE OR REPLACE VIEW service.clusters_for_admin_review
  WITH (security_invoker = true)
AS
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
