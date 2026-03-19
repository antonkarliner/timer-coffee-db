-- Fix: Add micro-stages to valid_stage constraint
-- The micro-stages architecture was implemented in v20260128-micro-stages but the
-- database constraint wasn't updated to include the new stages.
-- This migration adds the missing micro-stages to the valid_stage constraint.

-- Drop existing constraint
ALTER TABLE service.roaster_enrichment_jobs
DROP CONSTRAINT IF EXISTS valid_stage;

-- Add updated constraint with all stages (original + micro-stages)
ALTER TABLE service.roaster_enrichment_jobs
ADD CONSTRAINT valid_stage CHECK (
  stage IN (
    -- Original stages
    'triage',
    'evidence',
    'summary',
    'extract',
    'validate',
    'done',
    -- New micro-stages for evidence collection
    'fetch-candidates',
    'parse-candidates',
    'discover-links',
    'fetch-discovered',
    'parse-discovered',
    'aggregate-evidence'
  )
);

-- Update comments to reflect new pipeline
COMMENT ON COLUMN service.roaster_enrichment_jobs.stage IS 
'Pipeline stage: triage → [fetch-candidates → parse-candidates → discover-links → fetch-discovered → parse-discovered → aggregate-evidence] → summary → extract → validate → done';

-- Reset jobs stuck in legacy evidence stage to use micro-stages
-- These jobs were getting stuck due to timeouts in the monolithic evidence stage
UPDATE service.roaster_enrichment_jobs
SET 
  state = 'queued',
  stage = 'triage',
  stage_data = '{}',
  locked_at = NULL,
  locked_by = NULL,
  last_error = 'Reset to use micro-stages architecture after constraint fix',
  run_after = NOW()
WHERE 
  stage = 'evidence' 
  AND state = 'running';

-- Also reset any failed jobs that might be stuck
UPDATE service.roaster_enrichment_jobs
SET 
  state = 'queued',
  stage = 'triage',
  stage_data = '{}',
  locked_at = NULL,
  locked_by = NULL,
  last_error = NULL,
  run_after = NOW()
WHERE 
  state = 'failed'
  AND attempts < 3;
