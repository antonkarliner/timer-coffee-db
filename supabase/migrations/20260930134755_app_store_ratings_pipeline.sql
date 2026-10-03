-- Daily app-store snapshots. Only aggregate ratings are public.
create table public.app_store_ratings (
  store text primary key check (store in ('app_store', 'google_play')),
  app_id text not null,
  average_rating numeric check (average_rating between 1 and 5),
  rating_count bigint check (rating_count >= 0),
  source_date date not null,
  fetched_at timestamptz not null default now(),
  methodology text not null,
  is_approximate boolean not null default true,
  coverage jsonb not null default '{}'::jsonb,
  check (average_rating is not null or rating_count = 0)
);
alter table public.app_store_ratings enable row level security;
revoke all on public.app_store_ratings from public, anon, authenticated;
grant select on public.app_store_ratings to anon, authenticated;
grant all on public.app_store_ratings to service_role;
create policy ratings_public_read on public.app_store_ratings for select to anon, authenticated using (true);
create policy ratings_service_write on public.app_store_ratings for all to service_role using (true) with check (true);

create table service.app_store_rating_runs (
  store text not null check (store in ('app_store', 'google_play')),
  collection_date date not null,
  app_id text not null,
  countries text[] not null,
  status text not null default 'collecting' check (status in ('collecting', 'complete', 'blocked', 'failed')),
  lease_token uuid,
  lease_until timestamptz,
  last_error_code text,
  updated_at timestamptz not null default now(),
  primary key (store, collection_date)
);
create table service.app_store_rating_observations (
  store text not null,
  collection_date date not null,
  country text not null check (country ~ '^[a-z]{2}$'),
  status text not null check (status in ('ok', 'unavailable')),
  average_rating numeric check (average_rating between 1 and 5),
  rating_count bigint check (rating_count >= 0),
  source_date date not null,
  fetched_at timestamptz not null default now(),
  primary key (store, collection_date, country),
  foreign key (store, collection_date) references service.app_store_rating_runs on delete cascade
);
alter table service.app_store_rating_runs enable row level security;
alter table service.app_store_rating_observations enable row level security;
revoke all on service.app_store_rating_runs, service.app_store_rating_observations from public, anon, authenticated;
grant all on service.app_store_rating_runs, service.app_store_rating_observations to service_role;
create policy ratings_runs_service on service.app_store_rating_runs for all to service_role using (true) with check (true);
create policy ratings_observations_service on service.app_store_rating_observations for all to service_role using (true) with check (true);

-- Row locking and leases prevent overlapping invocations from publishing partial
-- sweeps or multiplying Apple's request rate. Each Apple invocation claims 10.
create function service.claim_store_ratings_run(p_store text, p_date date, p_app_id text, p_countries text[])
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  run service.app_store_rating_runs%rowtype;
  token uuid := gen_random_uuid();
  pending text[];
begin
  if p_store not in ('app_store', 'google_play') or p_app_id is null or p_countries is null
     or p_date <> (now() at time zone 'utc')::date then
    raise exception 'Invalid ratings run configuration';
  end if;
  if p_store = 'app_store' and (cardinality(p_countries) = 0 or
      cardinality(p_countries) <> (select count(distinct c) from unnest(p_countries) c) or
      exists (select 1 from unnest(p_countries) c where c !~ '^[a-z]{2}$' or c is null)) then
    raise exception 'Invalid storefront configuration';
  end if;
  insert into service.app_store_rating_runs (store, collection_date, app_id, countries)
  values (p_store, p_date, p_app_id, p_countries) on conflict do nothing;
  select * into run from service.app_store_rating_runs
  where store = p_store and collection_date = p_date for update;
  if run.app_id <> p_app_id or run.countries <> p_countries then
    raise exception 'Ratings configuration changed during collection';
  end if;
  if run.status = 'complete' then return jsonb_build_object('status', 'complete'); end if;
  if run.lease_until > now() then return jsonb_build_object('status', 'busy'); end if;
  select coalesce(array_agg(country order by country), '{}'::text[]) into pending from (
    select c as country from unnest(run.countries) c
    where not exists (select 1 from service.app_store_rating_observations o
      where o.store = p_store and o.collection_date = p_date and o.country = c)
    order by c limit 10
  ) countries;
  update service.app_store_rating_runs set lease_token = token, lease_until = now() + interval '3 minutes',
    status = 'collecting', updated_at = now() where store = p_store and collection_date = p_date;
  return jsonb_build_object('status', 'claimed', 'lease_token', token, 'countries', pending);
end;
$$;

create function service.finish_store_ratings_run(
  p_store text, p_date date, p_token uuid, p_observations jsonb,
  p_snapshot jsonb default null, p_error_code text default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  run service.app_store_rating_runs%rowtype;
  observed integer;
  available integer;
  rated integer;
  rating_total bigint;
  rating_average numeric;
  snapshot jsonb := p_snapshot;
  outcome text;
begin
  select * into run from service.app_store_rating_runs
  where store = p_store and collection_date = p_date for update;
  if not found or run.lease_token is distinct from p_token or p_token is null then
    raise exception 'Ratings lease does not match';
  end if;
  if p_error_code is not null and p_error_code !~ '^[a-z0-9_]{1,80}$' then raise exception 'Invalid error code'; end if;
  if jsonb_typeof(p_observations) <> 'array' then raise exception 'Invalid observations'; end if;
  if p_store = 'app_store' and exists (
    select 1 from jsonb_to_recordset(p_observations) as o(country text, status text, average_rating numeric, rating_count bigint, source_date date)
    where not (o.country = any(run.countries)) or o.source_date is distinct from p_date
      or (o.status = 'ok' and (o.rating_count is null or (o.rating_count > 0 and o.average_rating is null)))
  ) then raise exception 'Invalid storefront observation'; end if;
  insert into service.app_store_rating_observations (store, collection_date, country, status, average_rating, rating_count, source_date)
  select p_store, p_date, o.country, o.status, o.average_rating, o.rating_count, o.source_date
  from jsonb_to_recordset(p_observations) as o(country text, status text, average_rating numeric, rating_count bigint, source_date date)
  on conflict (store, collection_date, country) do update set
    status = excluded.status, average_rating = excluded.average_rating, rating_count = excluded.rating_count,
    source_date = excluded.source_date, fetched_at = now();

  if p_store = 'app_store' then
    select count(*), count(*) filter (where status = 'ok'), count(*) filter (where rating_count > 0),
      coalesce(sum(rating_count) filter (where status = 'ok'), 0),
      sum(average_rating * rating_count) filter (where status = 'ok') / nullif(sum(rating_count) filter (where status = 'ok'), 0)
    into observed, available, rated, rating_total, rating_average
    from service.app_store_rating_observations where store = p_store and collection_date = p_date;
    -- Do not mistake an entirely unavailable app for a valid zero-rating result.
    if observed = cardinality(run.countries) and available > 0 then
      snapshot := jsonb_build_object('average_rating', rating_average, 'rating_count', rating_total,
        'source_date', p_date, 'methodology', 'weighted_storefront_averages', 'coverage',
        jsonb_build_object('countriesRequested', observed, 'countriesAvailable', available, 'countriesWithRatings', rated));
    else snapshot := null;
    end if;
  end if;

  if snapshot is not null then
    if (snapshot->>'source_date')::date > p_date then raise exception 'Invalid snapshot date'; end if;
    insert into public.app_store_ratings (store, app_id, average_rating, rating_count, source_date, methodology, coverage)
    values (p_store, run.app_id, (snapshot->>'average_rating')::numeric, (snapshot->>'rating_count')::bigint,
      (snapshot->>'source_date')::date, snapshot->>'methodology', snapshot->'coverage')
    on conflict (store) do update set app_id = excluded.app_id, average_rating = excluded.average_rating,
      rating_count = excluded.rating_count, source_date = excluded.source_date, methodology = excluded.methodology,
      coverage = excluded.coverage, fetched_at = now()
    where public.app_store_ratings.source_date <= excluded.source_date;
    outcome := 'complete';
  elsif p_error_code is not null then outcome := 'failed';
  elsif p_store = 'google_play' then outcome := 'blocked';
  else outcome := 'collecting'; end if;
  update service.app_store_rating_runs set status = outcome, lease_token = null, lease_until = null,
    last_error_code = case when p_store = 'google_play' and outcome = 'blocked' then 'google_no_overall_rating' else p_error_code end,
    updated_at = now() where store = p_store and collection_date = p_date;
  delete from service.app_store_rating_runs where collection_date < p_date - 90;
  return jsonb_build_object('status', outcome, 'countriesCollected', jsonb_array_length(p_observations));
end;
$$;
revoke all on function service.claim_store_ratings_run(text, date, text, text[]) from public, anon, authenticated;
revoke all on function service.finish_store_ratings_run(text, date, uuid, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function service.claim_store_ratings_run(text, date, text, text[]) to service_role;
grant execute on function service.finish_store_ratings_run(text, date, uuid, jsonb, jsonb, text) to service_role;

-- Fixed dispatch targets only, private schema, no public RPC capable of making
-- credentialed HTTP requests. Credentials come from existing Vault entries.
create function service.dispatch_store_ratings(p_store text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  project_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url');
  cron_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'cron_job_secret');
  target text;
begin
  target := case p_store when 'app_store' then 'sync-app-store-ratings' when 'google_play' then 'sync-google-play-ratings' else null end;
  if target is null or project_url is null or cron_secret is null then raise exception 'Ratings cron configuration missing'; end if;
  -- pg_net returns a queue id; it is not the eventual HTTP outcome.
  return net.http_post(url := rtrim(project_url, '/') || '/functions/v1/' || target,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-System-Token', cron_secret),
    body := '{}'::jsonb, timeout_milliseconds := 140000);
end;
$$;
revoke all on function service.dispatch_store_ratings(text) from public, anon, authenticated, service_role;

select cron.schedule('sync-app-store-ratings-daily-batches', '*/5 2-4 * * *', $$select service.dispatch_store_ratings('app_store');$$);
select cron.schedule('sync-google-play-ratings-daily', '45 4 * * *', $$select service.dispatch_store_ratings('google_play');$$);
