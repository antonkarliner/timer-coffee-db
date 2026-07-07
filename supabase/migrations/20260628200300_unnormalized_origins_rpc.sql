-- Helper for the normalize-bean-origins edge function's backfill/cron mode:
-- returns one readable sample per distinct origin string that is NOT yet in the
-- normalization cache. SECURITY DEFINER so it can see every user's beans (the
-- edge function runs with the service role, but the distinct-on-normalized-key
-- anti-join is far cheaper expressed in SQL than paged through the client).

create or replace function public.get_unnormalized_bean_origins(p_limit integer default 200)
returns text[]
language sql
stable
security definer
set search_path = public, pg_catalog
as $function$
  select coalesce(array_agg(sample), '{}'::text[])
  from (
    select (array_agg(btrim(ucb.origin) order by ucb.origin))[1] as sample
    from public.user_coffee_beans ucb
    where nullif(btrim(ucb.origin), '') is not null
      and not exists (
        select 1
        from public.bean_origin_normalizations n
        where n.origin_key = public.normalize_origin_key(ucb.origin)
      )
    group by public.normalize_origin_key(ucb.origin)
    limit greatest(p_limit, 0)
  ) s;
$function$;

grant execute on function public.get_unnormalized_bean_origins(integer) to service_role;
