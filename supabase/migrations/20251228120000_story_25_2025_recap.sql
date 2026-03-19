-- Story 25 - 2025 recap backend features

-- 1) Global brews count RPC
create or replace function public.global_stats_range_count(
  p_start_date date,
  p_end_date date
)
returns bigint
language sql
security definer
set search_path = public
as $$
  select count(*)
  from public.global_stats
  where created_at >= p_start_date
    and created_at < p_end_date
    and water_amount between 50 and 5000;
$$;

-- 2) Yearly user liters (precomputed from public.global_stats)
create table if not exists public.yearly_user_liters (
  year int not null,
  user_id uuid not null,
  liters double precision not null default 0,
  brews int not null default 0,
  last_brew_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (year, user_id)
);

create index if not exists yearly_user_liters_year_liters_idx
  on public.yearly_user_liters (year, liters);

alter table public.yearly_user_liters enable row level security;

create policy yearly_user_liters_select_own
on public.yearly_user_liters
for select
using (auth.uid() = user_id);

create or replace function public.refresh_yearly_user_liters(p_year int)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.yearly_user_liters(year, user_id, liters, brews, last_brew_at, updated_at)
  select
    p_year,
    user_id,
    sum(greatest(water_amount, 0)) / 1000.0 as liters,
    count(*) as brews,
    max(created_at) as last_brew_at,
    now()
  from public.global_stats
  where user_id is not null
    and water_amount between 50 and 5000
    and created_at >= make_date(p_year, 1, 1)
    and created_at < make_date(p_year + 1, 1, 1)
  group by user_id
  on conflict (year, user_id) do update set
    liters = excluded.liters,
    brews = excluded.brews,
    last_brew_at = excluded.last_brew_at,
    updated_at = now();
$$;

create or replace function public.yearly_user_liters_percentile(
  p_year int,
  p_user_id uuid
)
returns table(
  percentile numeric,
  top_pct int,
  liters double precision,
  active_users int
)
language sql
security definer
set search_path = public
as $$
  with base as (
    select liters
    from public.yearly_user_liters
    where year = p_year and brews >= 1
  ),
  me as (
    select liters
    from public.yearly_user_liters
    where year = p_year and user_id = p_user_id
  ),
  counts as (
    select
      (select count(*) from base where liters < (select liters from me)) as less,
      (select count(*) from base where liters = (select liters from me)) as equal,
      (select count(*) from base) as n,
      (select liters from me) as my_liters
  )
  select
    case when n = 0 then null else 100.0 * (less + 0.5 * equal) / n end as percentile,
    case when n = 0 then null else greatest(1, round(100 - (100.0 * (less + 0.5 * equal) / n))) end as top_pct,
    my_liters,
    n
  from counts;
$$;

-- 3) Postcard exchange
create table if not exists public.yearly_wishes (
  id uuid primary key default gen_random_uuid(),
  author_user_id uuid,
  locale text,
  text text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  moderation_reason text
);

create table if not exists public.yearly_wish_deliveries (
  id uuid primary key default gen_random_uuid(),
  wish_id uuid not null references public.yearly_wishes(id) on delete cascade,
  recipient_user_id uuid not null,
  delivered_at timestamptz not null default now(),
  unique (wish_id, recipient_user_id)
);

alter table public.yearly_wishes enable row level security;

create policy yearly_wishes_insert_own
on public.yearly_wishes
for insert
with check (auth.uid() = author_user_id);

create policy yearly_wishes_select_own
on public.yearly_wishes
for select
using (auth.uid() = author_user_id);

alter table public.yearly_wish_deliveries enable row level security;

create policy yearly_wish_deliveries_select_own
on public.yearly_wish_deliveries
for select
using (auth.uid() = recipient_user_id);

create or replace function public.pick_yearly_wish(
  p_user_id uuid,
  p_locale text
)
returns table(id uuid, text text, locale text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lang text := split_part(coalesce(p_locale, ''), '-', 1);
  v_rec record;
begin
  select w.id, w.text, w.locale
  into v_rec
  from public.yearly_wishes w
  where w.status = 'approved'
    and (w.author_user_id is null or w.author_user_id <> p_user_id)
    and not exists (
      select 1 from public.yearly_wish_deliveries d
      where d.wish_id = w.id and d.recipient_user_id = p_user_id
    )
  order by
    (w.locale = p_locale) desc,
    (w.locale = v_lang) desc,
    (w.locale is null or w.locale = '' or w.locale = 'und') desc,
    w.created_at desc
  limit 1;

  if v_rec.id is null then
    return;
  end if;

  insert into public.yearly_wish_deliveries(wish_id, recipient_user_id)
  values (v_rec.id, p_user_id)
  on conflict do nothing;

  return query select v_rec.id, v_rec.text, v_rec.locale;
end $$;

-- Optional cron (enable if desired)
-- create extension if not exists pg_cron;
-- do $cron$
-- declare
--   v_job_id integer;
-- begin
--   select jobid
--   into v_job_id
--   from cron.job
--   where jobname = 'refresh_yearly_user_liters_2025'
--   order by jobid desc
--   limit 1;
--
--   if v_job_id is not null then
--     perform cron.unschedule(v_job_id);
--   end if;
--
--   select cron.schedule(
--     'refresh_yearly_user_liters_2025',
--     '0 3 * * *',
--     'select public.refresh_yearly_user_liters(2025);'
--   )
--   into v_job_id;
-- end;
-- $cron$ language plpgsql;
