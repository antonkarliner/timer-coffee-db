-- Add original_author_id to user_recipes: provenance for recipe attribution.
-- Stamped by the app at import time and carried through copies, so the future
-- recipe gallery can show "by <author>" even when the source recipe is gone.
-- FK nulls on account deletion so attribution disappears without touching
-- recipe rows.

alter table public.user_recipes
  add column original_author_id uuid references auth.users (id) on delete set null;

comment on column public.user_recipes.original_author_id is
  'User who originally authored the recipe this row derives from (import provenance). Null for original works or when the author account was deleted.';

create index user_recipes_original_author_id_idx
  on public.user_recipes (original_author_id)
  where original_author_id is not null;

-- Backfill imported rows: import_id embeds the original author''s user id as
-- usr-<uuid>-<timestamp>. Only stamp when the parsed uuid still exists in
-- auth.users (FK requirement); legacy truncated ids simply stay null.
update public.user_recipes ur
set original_author_id = parsed.uid
from (
  select id,
         substring(import_id from '^usr-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})')::uuid as uid
  from public.user_recipes
  where import_id ~* '^usr-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-'
) parsed
where ur.id = parsed.id
  and parsed.uid in (select id from auth.users);
