-- Brew Diary redesign schema wave (app plans 022 + 012, local schema v39):
-- per-brew water temperature, optional one-tap taste feedback, and a marker
-- for whether the entry came from a timer brew or manual entry. All nullable —
-- old clients keep inserting without them.
ALTER TABLE public.user_stats
  ADD COLUMN taste_balance smallint
    CONSTRAINT user_stats_taste_balance_range
    CHECK (taste_balance IN (-1, 0, 1)),
  ADD COLUMN water_temp real,
  ADD COLUMN entry_source smallint;

-- Per-recipe water temperature override, mirroring custom_grind_size.
ALTER TABLE public.user_recipe_preferences
  ADD COLUMN custom_water_temp real;
