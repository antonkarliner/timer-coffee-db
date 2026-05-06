-- Wrap auth.uid() in a subselect so Postgres evaluates it once per query
-- instead of once per row (Supabase advisor 0003_auth_rls_initplan).

drop policy if exists "Self read access" on public.recipe_import_events;

create policy "Self read access"
  on public.recipe_import_events
  for select
  using (importer_user_id = (select auth.uid()));
