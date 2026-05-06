-- Reviewer-supplied re-enrichment context on roaster_enrichment_jobs.
--
-- When a human reviewer marks a roaster cluster `hold / re-enrich`, the new job
-- can carry the reason, free-text notes, and a pointer to the rejected
-- enrichment result. The worker reads these and feeds them into prompts so the
-- LLM has a chance to correct itself instead of repeating the same mistake.
--
-- All three columns are nullable; first-time enrichments and system retries
-- leave them NULL and behave exactly as before.

ALTER TABLE service.roaster_enrichment_jobs
  ADD COLUMN IF NOT EXISTS reviewer_notes text NULL,
  ADD COLUMN IF NOT EXISTS rejection_reason text NULL,
  ADD COLUMN IF NOT EXISTS prior_result_id uuid NULL
    REFERENCES service.roaster_enrichment_results(id) ON DELETE SET NULL;

DO $$
BEGIN
  ALTER TABLE service.roaster_enrichment_jobs
    DROP CONSTRAINT IF EXISTS roaster_enrichment_jobs_rejection_reason_check;

  ALTER TABLE service.roaster_enrichment_jobs
    ADD CONSTRAINT roaster_enrichment_jobs_rejection_reason_check CHECK (
      rejection_reason IS NULL OR rejection_reason IN (
        'wrong_entity',
        'ambiguous_identity',
        'logo_missing',
        'location_mismatch',
        'contaminated_data',
        'stale_data',
        'other'
      )
    );
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'rejection_reason constraint operation failed: %', SQLERRM;
END $$;

CREATE INDEX IF NOT EXISTS roaster_enrichment_jobs_prior_result_idx
  ON service.roaster_enrichment_jobs (prior_result_id);
