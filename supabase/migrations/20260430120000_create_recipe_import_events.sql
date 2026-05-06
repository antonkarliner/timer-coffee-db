-- Track per-(source recipe, importer) recipe import events so creators can
-- see how many distinct users imported a recipe they shared. Decoupled from
-- public.user_recipes so the historical fact survives local deletes and
-- counts anonymous Supabase sessions.

create table public.recipe_import_events (
  id uuid primary key default gen_random_uuid(),
  import_id text not null,
  importer_user_id uuid not null,
  imported_at timestamptz not null default now(),
  unique (import_id, importer_user_id)
);

create index recipe_import_events_import_id_idx
  on public.recipe_import_events (import_id);

alter table public.recipe_import_events enable row level security;

create policy "Self read access"
  on public.recipe_import_events
  for select
  using (importer_user_id = auth.uid());

create or replace function public.log_recipe_import(p_import_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;

  if p_import_id like ('usr-' || v_uid::text || '-%') then
    return;
  end if;

  insert into public.recipe_import_events (import_id, importer_user_id)
  values (p_import_id, v_uid)
  on conflict (import_id, importer_user_id) do nothing;
end;
$$;

revoke all on function public.log_recipe_import(text) from public;
grant execute on function public.log_recipe_import(text) to anon, authenticated;

create or replace function public.get_user_recipe_import_counts(p_recipe_ids text[])
returns table (recipe_id text, import_count bigint)
language sql
security definer
stable
set search_path = public
as $$
  select e.import_id as recipe_id, count(*)::bigint as import_count
  from public.recipe_import_events e
  where e.import_id = any(p_recipe_ids)
  group by e.import_id;
$$;

revoke all on function public.get_user_recipe_import_counts(text[]) from public;
grant execute on function public.get_user_recipe_import_counts(text[]) to anon, authenticated;

create index if not exists user_recipes_import_id_active_idx
  on public.user_recipes (import_id)
  where import_id is not null and is_deleted = false;
