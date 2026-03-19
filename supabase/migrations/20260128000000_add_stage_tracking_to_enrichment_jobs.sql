-- Add stage tracking to roaster_enrichment_jobs for multi-stage pipeline processing
-- This allows breaking the CPU-intensive enrichment work into smaller chunks
-- to stay within Supabase Edge Function's 2-second CPU time limit

-- Add stage tracking columns
ALTER TABLE service.roaster_enrichment_jobs
  ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'triage',
  ADD COLUMN IF NOT EXISTS stage_data jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS correlation_id text NULL;

-- Create index for efficient stage-based job querying
CREATE INDEX IF NOT EXISTS idx_roaster_enrichment_jobs_stage 
  ON service.roaster_enrichment_jobs (state, stage, run_after);

-- Add check constraint for valid stages
DO $$
BEGIN
  -- Drop existing constraint if it exists to avoid errors
  ALTER TABLE service.roaster_enrichment_jobs
    DROP CONSTRAINT IF EXISTS valid_stage;
    
  -- Add the constraint
  ALTER TABLE service.roaster_enrichment_jobs
    ADD CONSTRAINT valid_stage CHECK (
      stage IN ('triage', 'evidence', 'summary', 'extract', 'validate', 'done')
    );
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Constraint operation failed: %', SQLERRM;
END $$;

-- Migrate existing jobs to use the new stage column
-- Jobs that are already done should stay as 'done'
-- Jobs that are queued/running should start from 'triage'
UPDATE service.roaster_enrichment_jobs
SET stage = CASE 
  WHEN state = 'done' THEN 'done'
  ELSE 'triage'
END
WHERE stage = 'triage' AND stage_data = '{}';

-- Add comment explaining the stages
COMMENT ON COLUMN service.roaster_enrichment_jobs.stage IS 
'Pipeline stage: triage → evidence → summary → extract → validate → done';

COMMENT ON COLUMN service.roaster_enrichment_jobs.stage_data IS 
'JSON storage for intermediate results between pipeline stages';
