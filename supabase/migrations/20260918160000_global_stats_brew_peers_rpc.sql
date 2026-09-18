-- Plan 038 section 3: move finish-screen peer aggregation behind an RPC so
-- public.global_stats.user_id can later be revoked from client roles.
-- Authenticated only: the caller must be signed in so auth.uid() excludes them.

create or replace function public.get_brew_peers(
  p_window_start timestamptz,
  p_window_end timestamptz
)
returns table (
  peer_count integer,
  country_codes text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  with effective_window as (
    select least(
      p_window_end,
      p_window_start + interval '5 minutes'
    ) as window_end
  ),
  peers as (
    select
      public.global_stats.user_id,
      -- min() is a deterministic substitute for the client's first country seen.
      pg_catalog.min(
        nullif(
          pg_catalog.upper(pg_catalog.btrim(public.global_stats.country_code)),
          ''
        )
      ) as country
    from public.global_stats
    cross join effective_window
    where p_window_start is not null
      and p_window_end is not null
      and public.global_stats.created_at >= p_window_start
      and public.global_stats.created_at <= effective_window.window_end
      and public.global_stats.user_id is not null
      and public.global_stats.user_id is distinct from auth.uid()
    group by public.global_stats.user_id
  )
  select
    pg_catalog.count(*)::integer as peer_count,
    coalesce(
      pg_catalog.array_agg(peers.country) filter (where peers.country is not null),
      '{}'::text[]
    ) as country_codes
  from peers;
$$;

revoke execute on function public.get_brew_peers(timestamptz, timestamptz) from public;
revoke execute on function public.get_brew_peers(timestamptz, timestamptz) from anon;
grant execute on function public.get_brew_peers(timestamptz, timestamptz)
  to authenticated, service_role;
