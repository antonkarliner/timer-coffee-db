-- Restore legacy-compatible Brew Diary fields emitted by the app's
-- user_stats serializer. coffee_beans_uuid remains the canonical bean identity;
-- coffee_beans_id is retained only for compatibility with older local rows.
ALTER TABLE public.user_stats
  ADD COLUMN IF NOT EXISTS beans text,
  ADD COLUMN IF NOT EXISTS roaster text,
  ADD COLUMN IF NOT EXISTS rating real,
  ADD COLUMN IF NOT EXISTS coffee_beans_id bigint;
