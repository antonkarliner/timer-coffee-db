-- Custom tags on brew diary entries (app plan 028, local schema v40).
-- Comma-separated text, mirroring coffee_beans.tasting_notes. Nullable — old
-- clients keep inserting without it.
ALTER TABLE public.user_stats
  ADD COLUMN tags text;
