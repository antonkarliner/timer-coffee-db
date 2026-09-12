-- Record WHEN a row was soft-deleted, not just that it was.
--
-- These three tables already carry an `is_deleted` boolean, but nothing stores
-- the deletion time, so there is no way to build a retention window (a "trash
-- bin", or a job that finally purges old tombstones) without guessing. App
-- plan 056 Phase 2; the app-side Drift schema moves to v41 in the same pass.
--
-- Nothing writes these columns yet. Phases 3 and 4 of that plan do.

alter table public.user_stats
  add column if not exists deleted_at timestamptz;

alter table public.user_coffee_beans
  add column if not exists deleted_at timestamptz;

alter table public.user_recipes
  add column if not exists deleted_at timestamptz;

-- DELIBERATELY NO BACKFILL.
--
-- As of this migration ~13,784 user_stats rows and ~656 user_coffee_beans rows
-- are already tombstoned, and their real deletion times are unknown — the
-- information was never recorded. Backfilling them with now(), created_at, or
-- any other stand-in would invent a deletion date, and the first retention job
-- that trusts it would permanently destroy real user data on the strength of a
-- guess. Leave them NULL.
--
-- Any future purge MUST therefore treat `deleted_at is null` as "unknown age,
-- do not purge", never as "old enough to delete".

comment on column public.user_stats.deleted_at is
  'When the row was soft-deleted. NULL means either not deleted, or deleted before this column existed — never treat NULL as old enough to purge.';

comment on column public.user_coffee_beans.deleted_at is
  'When the row was soft-deleted. NULL means either not deleted, or deleted before this column existed — never treat NULL as old enough to purge.';

comment on column public.user_recipes.deleted_at is
  'When the row was soft-deleted. NULL means either not deleted, or deleted before this column existed — never treat NULL as old enough to purge.';
