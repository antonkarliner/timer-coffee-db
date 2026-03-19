-- Feature flags for client apps
create table public.feature_flags (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  enabled boolean not null default false,
  description text,
  platforms text[] default null,
  min_build int default null,
  max_build int default null,
  updated_at timestamptz not null default now()
);

-- RLS: allow read-only access
alter table public.feature_flags enable row level security;

create policy "feature_flags_read_anon" on public.feature_flags
  for select
  to anon
  using (true);

create policy "feature_flags_read_authenticated" on public.feature_flags
  for select
  to authenticated
  using (true);

grant select on public.feature_flags to anon;
grant select on public.feature_flags to authenticated;
