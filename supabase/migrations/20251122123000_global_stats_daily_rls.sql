-- RLS for aggregated global stats daily table
alter table public.global_stats_daily enable row level security;

-- Read-only access for client roles (data is already aggregated and non-sensitive).
create policy global_stats_daily_select_clients
  on public.global_stats_daily
  for select
  to anon, authenticated
  using (true);

-- Full access for service role and internal maintenance.
create policy global_stats_daily_service_role
  on public.global_stats_daily
  for all
  to service_role
  using (true)
  with check (true);

-- Optional: prevent other roles from writing by omitting insert/update/delete policies for them.
