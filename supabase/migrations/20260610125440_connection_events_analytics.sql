-- Lightweight analytics for the app's Supabase endpoint resolver: how many app
-- connections go direct vs. through the reverse proxy (the blocked-region path,
-- primarily Russia). One anonymous row per device per day (the client dedupes
-- via SharedPreferences). No user identifier is stored.
--
-- The table is write-only: RLS is enabled with no policies, and the only write
-- path is the SECURITY DEFINER RPC below. Direct table access from anon /
-- authenticated is therefore denied, so no table GRANTs are issued.
create table if not exists public.connection_events (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null check (endpoint in ('direct', 'proxy')),
  platform text check (platform in ('ios', 'android', 'web', 'other')),
  created_at timestamptz not null default now()
);

comment on table public.connection_events is
  'Anonymous direct-vs-proxy connection telemetry. Written only via log_connection_endpoint(). No user identifier.';

create index if not exists connection_events_created_at_idx
  on public.connection_events (created_at);

alter table public.connection_events enable row level security;

-- Records a single connection event. Validates/sanitizes inputs; silently
-- ignores an invalid endpoint so a bad client never errors a fire-and-forget call.
create or replace function public.log_connection_endpoint(
  p_endpoint text,
  p_platform text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_endpoint not in ('direct', 'proxy') then
    return;
  end if;
  insert into public.connection_events (endpoint, platform)
  values (
    p_endpoint,
    case when p_platform in ('ios', 'android', 'web', 'other') then p_platform else null end
  );
end;
$$;

revoke all on function public.log_connection_endpoint(text, text) from public;
grant execute on function public.log_connection_endpoint(text, text) to anon, authenticated;
