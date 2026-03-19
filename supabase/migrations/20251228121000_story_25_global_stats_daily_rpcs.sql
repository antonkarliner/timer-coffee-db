-- Story 25 - Global Stats Daily RPCs

create or replace function public.global_stats_daily_range_sum(
  p_start_date date,
  p_end_date date
)
returns numeric
language sql
security definer
set search_path = public
as $$
  select coalesce(sum(water_liters), 0)
  from public.global_stats_daily
  where date >= p_start_date
    and date < p_end_date;
$$;

create or replace function public.global_stats_daily_range_count(
  p_start_date date,
  p_end_date date
)
returns bigint
language sql
security definer
set search_path = public
as $$
  select coalesce(sum(brew_count), 0)
  from public.global_stats_daily
  where date >= p_start_date
    and date < p_end_date;
$$;

grant execute on function public.global_stats_daily_range_sum(date, date) to anon, authenticated;
grant execute on function public.global_stats_daily_range_count(date, date) to anon, authenticated;
