-- Add the worker-owned search checkpoint without changing any job rows.
ALTER TABLE service.roaster_enrichment_jobs
  DROP CONSTRAINT IF EXISTS valid_stage;

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
      'search-candidates',
      'fetch-candidates',
      'parse-candidates',
      'discover-links',
      'fetch-discovered',
      'parse-discovered',
      'aggregate-evidence'
    )
  );

COMMENT ON COLUMN service.roaster_enrichment_jobs.stage IS
  'Pipeline stage: triage -> search-candidates -> fetch-candidates -> parse-candidates -> discover-links -> fetch-discovered -> parse-discovered -> aggregate-evidence -> summary -> extract -> validate -> translate-location -> find-matches -> persist-result -> done';
