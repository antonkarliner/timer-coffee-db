-- Add new validate micro-stages to the valid_stage constraint
-- These stages were added to split the heavy validate stage into smaller checkpointed stages

DO $$
BEGIN
  -- Drop existing constraint
  ALTER TABLE service.roaster_enrichment_jobs
    DROP CONSTRAINT IF EXISTS valid_stage;
    
  -- Add updated constraint with all stages including new validate micro-stages
  ALTER TABLE service.roaster_enrichment_jobs
    ADD CONSTRAINT valid_stage CHECK (
      stage IN (
        'triage', 
        'evidence', 
        'summary', 
        'extract', 
        'validate',
        'translate-location',
        'find-matches',
        'persist-result',
        'done',
        'fetch-candidates', 
        'parse-candidates', 
        'discover-links', 
        'fetch-discovered', 
        'parse-discovered', 
        'aggregate-evidence'
      )
    );
    
  RAISE NOTICE 'Updated valid_stage constraint to include validate micro-stages';
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Constraint operation failed: %', SQLERRM;
END $$;

