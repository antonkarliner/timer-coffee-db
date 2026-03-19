-- Create daily pre-aggregation table for global stats
create table if not exists public.global_stats_daily (
  date date primary key,
  water_liters numeric,
  brew_count integer,
  top_recipes jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint global_stats_daily_water_liters_nonnegative check (
    water_liters is null or water_liters >= 0
  ),
  constraint global_stats_daily_top_recipes_length check (
    top_recipes is null or (jsonb_typeof(top_recipes) = 'array' and jsonb_array_length(top_recipes) <= 5)
  )
);

-- Ensure supporting indexes on source table for efficient aggregation
create index if not exists global_stats_created_at_idx on public.global_stats (created_at);
create index if not exists global_stats_recipe_created_at_idx on public.global_stats (recipe_id, created_at);

-- Upsert daily aggregates for a specific date (default: yesterday).
-- Idempotent: rerunning will refresh values; days with no data are removed.
create or replace function public.refresh_global_stats_daily(p_target_date date default (current_date - 1))
returns void
language plpgsql
as $$
declare
  v_now timestamptz := timezone('utc', now());
  v_has_data boolean;
begin
  select exists (
    select 1 from public.global_stats gs where gs.created_at::date = p_target_date
  ) into v_has_data;

  if not v_has_data then
    delete from public.global_stats_daily where date = p_target_date;
    return;
  end if;

  insert into public.global_stats_daily (
    date, water_liters, brew_count, top_recipes, created_at, updated_at
  )
  select
    p_target_date,
    sum(gs.water_amount) / 1000.0 as water_liters,
    count(*) as brew_count,
    (
      select jsonb_agg(r order by r.count desc)
      from (
        select recipe_id, count(*) as count
        from public.global_stats gs2
        where gs2.created_at::date = p_target_date
        group by recipe_id
        order by count desc
        limit 5
      ) r
    ) as top_recipes,
    v_now,
    v_now
  from public.global_stats gs
  where gs.created_at::date = p_target_date
  group by p_target_date
  on conflict (date) do update
    set water_liters = excluded.water_liters,
        brew_count   = excluded.brew_count,
        top_recipes  = excluded.top_recipes,
        updated_at   = excluded.updated_at;
end;
$$;

-- Convenience helper for one-time full backfill; safe to rerun.
create or replace function public.backfill_global_stats_daily()
returns integer
language sql
as $$
  with daily as (
    select
      gs.created_at::date as day,
      sum(gs.water_amount) / 1000.0 as water_liters,
      count(*) as brew_count
    from public.global_stats gs
    group by gs.created_at::date
  ),
  upsert as (
    insert into public.global_stats_daily (date, water_liters, brew_count, top_recipes, created_at, updated_at)
    select
      d.day as date,
      d.water_liters,
      d.brew_count,
      (
        select jsonb_agg(r order by r.count desc)
        from (
          select recipe_id, count(*) as count
          from public.global_stats gs2
          where gs2.created_at::date = d.day
          group by recipe_id
          order by count desc
          limit 5
        ) r
      ) as top_recipes,
      timezone('utc', now()) as created_at,
      timezone('utc', now()) as updated_at
    from daily d
    on conflict (date) do update
      set water_liters = excluded.water_liters,
          brew_count   = excluded.brew_count,
          top_recipes  = excluded.top_recipes,
          updated_at   = excluded.updated_at
    returning 1
  )
  select count(*) from upsert;
$$;
