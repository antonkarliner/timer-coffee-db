-- Move feature flags into service schema (anon-readable)

-- Remove previous public table if it exists
drop table if exists public.feature_flags cascade;

-- Ensure service schema is available
create schema if not exists service;

-- Feature flags table (service schema)
create table service.feature_flags (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  enabled boolean not null default false,
  description text,
  platforms text[] default null,
  min_build int default null,
  max_build int default null,
  updated_at timestamptz not null default now()
);

-- Keep updated_at fresh on updates
do $$
begin
  if to_regproc('service.set_updated_at') is not null then
    create trigger trg_service_feature_flags_set_updated_at
      before update on service.feature_flags
      for each row execute function service.set_updated_at();
  end if;
end$$;

-- RLS: anon/authenticated read
alter table service.feature_flags enable row level security;

create policy "feature_flags_read_anon" on service.feature_flags
  for select
  to anon
  using (true);

create policy "feature_flags_read_authenticated" on service.feature_flags
  for select
  to authenticated
  using (true);

-- Grants so clients can read flags
grant usage on schema service to anon;
grant select on service.feature_flags to anon;
grant select on service.feature_flags to authenticated;
