create extension if not exists pg_cron;

-- Sum liters for a date range, combining daily aggregates with raw data for dates not yet aggregated.
create or replace function public.global_stats_range_sum(
  p_start_date date,
  p_end_date date
)
returns table (
  total_liters numeric,
  partial_liters numeric,
  total numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_agg numeric := 0;
  v_partial numeric := 0;
begin
  if p_start_date is null or p_end_date is null then
    raise exception 'start_date and end_date are required';
  end if;
  if p_start_date > p_end_date then
    raise exception 'start_date (%) is after end_date (%)', p_start_date, p_end_date;
  end if;

  select coalesce(sum(water_liters), 0)
  into v_agg
  from public.global_stats_daily
  where date between p_start_date and p_end_date;

  select coalesce(sum(gs.water_amount) / 1000.0, 0)
  into v_partial
  from public.global_stats gs
  where gs.created_at::date between p_start_date and p_end_date
    and not exists (
      select 1
      from public.global_stats_daily gsd
      where gsd.date = gs.created_at::date
    );

  total_liters := v_agg;
  partial_liters := v_partial;
  total := v_agg + v_partial;
  return next;
end;
$$;

comment on function public.global_stats_range_sum(date, date) is
  'Returns liters for a date range: totals from daily aggregates plus raw data for dates not yet aggregated (e.g., today).';

-- Top recipes for a date range; merges daily aggregates with raw data for missing days.
create or replace function public.global_stats_top_recipes(
  p_start_date date,
  p_end_date date,
  p_top_n integer default 5
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit integer := greatest(coalesce(p_top_n, 5), 1);
  v_result jsonb := '[]'::jsonb;
begin
  if p_start_date is null or p_end_date is null then
    raise exception 'start_date and end_date are required';
  end if;
  if p_start_date > p_end_date then
    raise exception 'start_date (%) is after end_date (%)', p_start_date, p_end_date;
  end if;

  with dates as (
    select generate_series(p_start_date, p_end_date, interval '1 day')::date as d
  ),
  agg_recipes as (
    select jsonb_array_elements(coalesce(gsd.top_recipes, '[]'::jsonb)) as rec
    from public.global_stats_daily gsd
    join dates on dates.d = gsd.date
  ),
  agg_counts as (
    select rec->>'recipe_id' as recipe_id,
           (rec->>'count')::bigint as cnt
    from agg_recipes
    where rec ? 'recipe_id'
  ),
  missing_dates as (
    select d
    from dates d
    where not exists (
      select 1
      from public.global_stats_daily gsd
      where gsd.date = d.d
    )
  ),
  raw_counts as (
    select gs.recipe_id, count(*) as cnt
    from public.global_stats gs
    where gs.recipe_id is not null
      and gs.created_at::date in (select d from missing_dates)
    group by gs.recipe_id
  ),
  combined as (
    select recipe_id, sum(cnt) as cnt
    from (
      select * from agg_counts
      union all
      select * from raw_counts
    ) s
    group by recipe_id
  ),
  ranked as (
    select recipe_id,
           cnt,
           row_number() over (order by cnt desc, recipe_id asc) as rn
    from combined
  )
  select coalesce(
           jsonb_agg(jsonb_build_object('recipe_id', recipe_id, 'count', cnt)
             order by cnt desc, recipe_id asc),
           '[]'::jsonb
         )
  into v_result
  from ranked
  where rn <= v_limit;

  return v_result;
end;
$$;

comment on function public.global_stats_top_recipes(date, date, integer) is
  'Returns a jsonb array of top recipes [{recipe_id, count}] for the range, merging daily aggregates with raw data for dates not yet aggregated.';

-- Nightly job entrypoint: refresh the previous UTC day (default behavior of refresh_global_stats_daily).
create or replace function public.cron_refresh_global_stats_daily()
returns void
language sql
security definer
set search_path = public
as $$
  select public.refresh_global_stats_daily();
$$;

comment on function public.cron_refresh_global_stats_daily() is
  'Invoked by pg_cron to refresh yesterday''s global stats daily aggregate.';

-- Schedule nightly refresh at 02:10 UTC; reset any existing job with same name to avoid duplicates.
do $cron$
declare
  v_job_id integer;
begin
  select jobid
  into v_job_id
  from cron.job
  where jobname = 'refresh-global-stats-daily'
  order by jobid desc
  limit 1;

  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  select cron.schedule(
    'refresh-global-stats-daily',
    '10 2 * * *',
    'select public.cron_refresh_global_stats_daily();'
  )
  into v_job_id;
end;
$cron$
language plpgsql;

-- Expose RPCs to client roles.
grant execute on function public.global_stats_range_sum(date, date) to anon, authenticated;
grant execute on function public.global_stats_top_recipes(date, date, integer) to anon, authenticated;
