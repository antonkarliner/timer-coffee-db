-- Extraction calculator (app plan 013 Phase 3): store the measured TDS and
-- the computed extraction yield on a brew's user_stats row. Both nullable —
-- only set when the user saves a calculator result to a brew.
ALTER TABLE public.user_stats
  ADD COLUMN tds_percent real
    CONSTRAINT user_stats_tds_percent_range
    CHECK (tds_percent > 0 AND tds_percent < 30),
  ADD COLUMN extraction_yield_percent real
    CONSTRAINT user_stats_extraction_yield_percent_range
    CHECK (extraction_yield_percent > 0 AND extraction_yield_percent < 40);
