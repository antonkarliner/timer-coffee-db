-- Track when a local "write a review" nudge notification was scheduled for a bean,
-- so the once-only nudge state survives device changes for signed-in users.
ALTER TABLE public.user_coffee_beans
  ADD COLUMN IF NOT EXISTS review_nudge_scheduled_at timestamptz NULL;
