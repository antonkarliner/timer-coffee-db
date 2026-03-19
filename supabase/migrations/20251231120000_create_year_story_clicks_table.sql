-- Ensure service schema is available
create schema if not exists service;

-- Click log table for year story
create table if not exists service.year_story_clicks (
  id bigserial primary key,
  created_at timestamptz not null default now(),

  src text null,
  platform text null,
  app_version text null,
  locale text null,
  install_id text null,
  user_agent text null
);

create index if not exists year_story_clicks_install_time_idx
  on service.year_story_clicks (install_id, created_at desc);

-- RLS: allow authenticated users to insert
alter table service.year_story_clicks enable row level security;

create policy "year_story_clicks_insert_authenticated"
  on service.year_story_clicks
  for insert
  with check (auth.role() = 'authenticated');

grant usage on schema service to authenticated;
grant insert on table service.year_story_clicks to authenticated;
