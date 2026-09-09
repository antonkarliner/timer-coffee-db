create schema if not exists "analytics";


  create table if not exists "analytics"."bmc_support_events" (
    "id" uuid not null default gen_random_uuid(),
    "configured_event_type" text not null,
    "received_at" timestamp with time zone not null default now(),
    "payload" jsonb not null,
    "payload_sha256" text not null,
    "signature_header" text,
    "match_status" text not null default 'not_applicable'::text,
    "candidate_count" integer not null default 0,
    "matched_install_id" text,
    "matched_platform" text,
    "matched_button_event_id" uuid,
    "matched_button_ts" timestamp with time zone
      );


alter table "analytics"."bmc_support_events" enable row level security;


  create table if not exists "analytics"."daily_metrics" (
    "date" date not null,
    "platform" text not null,
    "metric_name" text not null,
    "metric_value" numeric not null default 0,
    "dimensions" jsonb not null default '{}'::jsonb,
    "updated_at" timestamp with time zone default now()
      );


alter table "analytics"."daily_metrics" enable row level security;


  create table if not exists "analytics"."raw_events" (
    "id" uuid not null default gen_random_uuid(),
    "event_name" text not null,
    "category" text not null,
    "session_id" uuid not null,
    "install_id" text not null,
    "platform" text not null,
    "app_version" text not null,
    "properties" jsonb default '{}'::jsonb,
    "client_ts" timestamp with time zone not null,
    "server_ts" timestamp with time zone not null default now(),
    "country" text
      ) partition by RANGE (server_ts);


alter table "analytics"."raw_events" enable row level security;


  create table if not exists "analytics"."raw_events_y2026m03" partition of "analytics"."raw_events" FOR VALUES FROM ('2026-03-01 00:00:00+00') TO ('2026-04-01 00:00:00+00');



  create table if not exists "analytics"."raw_events_y2026m04" partition of "analytics"."raw_events" FOR VALUES FROM ('2026-04-01 00:00:00+00') TO ('2026-05-01 00:00:00+00');



  create table if not exists "analytics"."raw_events_y2026m05" partition of "analytics"."raw_events" FOR VALUES FROM ('2026-05-01 00:00:00+00') TO ('2026-06-01 00:00:00+00');



  create table if not exists "analytics"."raw_events_y2026m06" partition of "analytics"."raw_events" FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');


CREATE INDEX IF NOT EXISTS bmc_support_events_match_status_idx ON analytics.bmc_support_events USING btree (match_status, received_at DESC);

CREATE INDEX IF NOT EXISTS bmc_support_events_matched_install_id_idx ON analytics.bmc_support_events USING btree (matched_install_id) WHERE (matched_install_id IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS bmc_support_events_pkey ON analytics.bmc_support_events USING btree (id);

CREATE INDEX IF NOT EXISTS bmc_support_events_received_at_idx ON analytics.bmc_support_events USING btree (received_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS bmc_support_events_type_event_id_idx ON analytics.bmc_support_events USING btree (configured_event_type, ((payload ->> 'event_id'::text))) WHERE (payload ? 'event_id'::text);

CREATE UNIQUE INDEX IF NOT EXISTS bmc_support_events_type_payload_sha256_idx ON analytics.bmc_support_events USING btree (configured_event_type, payload_sha256);

CREATE INDEX IF NOT EXISTS bmc_support_events_type_received_at_idx ON analytics.bmc_support_events USING btree (configured_event_type, received_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS daily_metrics_pkey ON analytics.daily_metrics USING btree (date, platform, metric_name, dimensions);

CREATE INDEX IF NOT EXISTS idx_raw_events_category ON analytics.raw_events USING btree (category, server_ts);

CREATE INDEX IF NOT EXISTS idx_raw_events_country ON analytics.raw_events USING btree (country, server_ts);

CREATE INDEX IF NOT EXISTS idx_raw_events_event_name ON analytics.raw_events USING btree (event_name, server_ts);

CREATE INDEX IF NOT EXISTS idx_raw_events_install_id ON analytics.raw_events USING btree (install_id, server_ts);


CREATE INDEX IF NOT EXISTS raw_events_y2026m03_category_server_ts_idx ON analytics.raw_events_y2026m03 USING btree (category, server_ts);

CREATE INDEX IF NOT EXISTS raw_events_y2026m03_country_server_ts_idx ON analytics.raw_events_y2026m03 USING btree (country, server_ts);

CREATE INDEX IF NOT EXISTS raw_events_y2026m03_event_name_server_ts_idx ON analytics.raw_events_y2026m03 USING btree (event_name, server_ts);

CREATE INDEX IF NOT EXISTS raw_events_y2026m03_install_id_server_ts_idx ON analytics.raw_events_y2026m03 USING btree (install_id, server_ts);

CREATE UNIQUE INDEX IF NOT EXISTS raw_events_y2026m03_pkey ON analytics.raw_events_y2026m03 USING btree (id, server_ts);

CREATE INDEX IF NOT EXISTS raw_events_y2026m04_category_server_ts_idx ON analytics.raw_events_y2026m04 USING btree (category, server_ts);

CREATE INDEX IF NOT EXISTS raw_events_y2026m04_country_server_ts_idx ON analytics.raw_events_y2026m04 USING btree (country, server_ts);

CREATE INDEX IF NOT EXISTS raw_events_y2026m04_event_name_server_ts_idx ON analytics.raw_events_y2026m04 USING btree (event_name, server_ts);

CREATE INDEX IF NOT EXISTS raw_events_y2026m04_install_id_server_ts_idx ON analytics.raw_events_y2026m04 USING btree (install_id, server_ts);

CREATE UNIQUE INDEX IF NOT EXISTS raw_events_y2026m04_pkey ON analytics.raw_events_y2026m04 USING btree (id, server_ts);

CREATE INDEX IF NOT EXISTS raw_events_y2026m05_category_server_ts_idx ON analytics.raw_events_y2026m05 USING btree (category, server_ts);

CREATE INDEX IF NOT EXISTS raw_events_y2026m05_country_server_ts_idx ON analytics.raw_events_y2026m05 USING btree (country, server_ts);

CREATE INDEX IF NOT EXISTS raw_events_y2026m05_event_name_server_ts_idx ON analytics.raw_events_y2026m05 USING btree (event_name, server_ts);

CREATE INDEX IF NOT EXISTS raw_events_y2026m05_install_id_server_ts_idx ON analytics.raw_events_y2026m05 USING btree (install_id, server_ts);

CREATE UNIQUE INDEX IF NOT EXISTS raw_events_y2026m05_pkey ON analytics.raw_events_y2026m05 USING btree (id, server_ts);

CREATE INDEX IF NOT EXISTS raw_events_y2026m06_category_server_ts_idx ON analytics.raw_events_y2026m06 USING btree (category, server_ts);

CREATE INDEX IF NOT EXISTS raw_events_y2026m06_country_server_ts_idx ON analytics.raw_events_y2026m06 USING btree (country, server_ts);

CREATE INDEX IF NOT EXISTS raw_events_y2026m06_event_name_server_ts_idx ON analytics.raw_events_y2026m06 USING btree (event_name, server_ts);

CREATE INDEX IF NOT EXISTS raw_events_y2026m06_install_id_server_ts_idx ON analytics.raw_events_y2026m06 USING btree (install_id, server_ts);

CREATE UNIQUE INDEX IF NOT EXISTS raw_events_y2026m06_pkey ON analytics.raw_events_y2026m06 USING btree (id, server_ts);

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'bmc_support_events_pkey' and conrelid = 'analytics.bmc_support_events'::regclass
  ) then
    alter table "analytics"."bmc_support_events" add constraint "bmc_support_events_pkey" PRIMARY KEY using index "bmc_support_events_pkey";
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'daily_metrics_pkey' and conrelid = 'analytics.daily_metrics'::regclass
  ) then
    alter table "analytics"."daily_metrics" add constraint "daily_metrics_pkey" PRIMARY KEY using index "daily_metrics_pkey";
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'raw_events_pkey' and conrelid = 'analytics.raw_events'::regclass
  ) then
    alter table "analytics"."raw_events" add constraint "raw_events_pkey" PRIMARY KEY (id, server_ts);
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'raw_events_y2026m03_pkey' and conrelid = 'analytics.raw_events_y2026m03'::regclass
  ) then
    alter table "analytics"."raw_events_y2026m03" add constraint "raw_events_y2026m03_pkey" PRIMARY KEY using index "raw_events_y2026m03_pkey";
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'raw_events_y2026m04_pkey' and conrelid = 'analytics.raw_events_y2026m04'::regclass
  ) then
    alter table "analytics"."raw_events_y2026m04" add constraint "raw_events_y2026m04_pkey" PRIMARY KEY using index "raw_events_y2026m04_pkey";
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'raw_events_y2026m05_pkey' and conrelid = 'analytics.raw_events_y2026m05'::regclass
  ) then
    alter table "analytics"."raw_events_y2026m05" add constraint "raw_events_y2026m05_pkey" PRIMARY KEY using index "raw_events_y2026m05_pkey";
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'raw_events_y2026m06_pkey' and conrelid = 'analytics.raw_events_y2026m06'::regclass
  ) then
    alter table "analytics"."raw_events_y2026m06" add constraint "raw_events_y2026m06_pkey" PRIMARY KEY using index "raw_events_y2026m06_pkey";
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'bmc_support_events_candidate_count_check' and conrelid = 'analytics.bmc_support_events'::regclass
  ) then
    alter table "analytics"."bmc_support_events" add constraint "bmc_support_events_candidate_count_check" CHECK ((candidate_count >= 0)) not valid;
  end if;
end $$;

alter table "analytics"."bmc_support_events" validate constraint "bmc_support_events_candidate_count_check";

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'bmc_support_events_configured_event_type_check' and conrelid = 'analytics.bmc_support_events'::regclass
  ) then
    alter table "analytics"."bmc_support_events" add constraint "bmc_support_events_configured_event_type_check" CHECK ((configured_event_type = ANY (ARRAY['support_created'::text, 'support_refunded'::text, 'monthly_support_started'::text, 'monthly_support_updated'::text, 'monthly_support_cancelled'::text]))) not valid;
  end if;
end $$;

alter table "analytics"."bmc_support_events" validate constraint "bmc_support_events_configured_event_type_check";

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'bmc_support_events_match_status_check' and conrelid = 'analytics.bmc_support_events'::regclass
  ) then
    alter table "analytics"."bmc_support_events" add constraint "bmc_support_events_match_status_check" CHECK ((match_status = ANY (ARRAY['matched'::text, 'unmatched'::text, 'ambiguous'::text, 'not_applicable'::text]))) not valid;
  end if;
end $$;

alter table "analytics"."bmc_support_events" validate constraint "bmc_support_events_match_status_check";

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'bmc_support_events_matched_platform_check' and conrelid = 'analytics.bmc_support_events'::regclass
  ) then
    alter table "analytics"."bmc_support_events" add constraint "bmc_support_events_matched_platform_check" CHECK (((matched_platform IS NULL) OR (matched_platform = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text])))) not valid;
  end if;
end $$;

alter table "analytics"."bmc_support_events" validate constraint "bmc_support_events_matched_platform_check";

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'raw_events_category_check' and conrelid = 'analytics.raw_events'::regclass
  ) then
    alter table "analytics"."raw_events" add constraint "raw_events_category_check" CHECK ((category = ANY (ARRAY['brews'::text, 'beans'::text, 'general'::text]))) not valid;
  end if;
end $$;

alter table "analytics"."raw_events" validate constraint "raw_events_category_check";

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'raw_events_platform_check' and conrelid = 'analytics.raw_events'::regclass
  ) then
    alter table "analytics"."raw_events" add constraint "raw_events_platform_check" CHECK ((platform = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text]))) not valid;
  end if;
end $$;

alter table "analytics"."raw_events" validate constraint "raw_events_platform_check";

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'raw_events_category_check' and conrelid = 'analytics.raw_events_y2026m03'::regclass
  ) then
    alter table "analytics"."raw_events_y2026m03" add constraint "raw_events_category_check" CHECK ((category = ANY (ARRAY['brews'::text, 'beans'::text, 'general'::text]))) not valid;
  end if;
end $$;

alter table "analytics"."raw_events_y2026m03" validate constraint "raw_events_category_check";

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'raw_events_platform_check' and conrelid = 'analytics.raw_events_y2026m03'::regclass
  ) then
    alter table "analytics"."raw_events_y2026m03" add constraint "raw_events_platform_check" CHECK ((platform = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text]))) not valid;
  end if;
end $$;

alter table "analytics"."raw_events_y2026m03" validate constraint "raw_events_platform_check";

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'raw_events_category_check' and conrelid = 'analytics.raw_events_y2026m04'::regclass
  ) then
    alter table "analytics"."raw_events_y2026m04" add constraint "raw_events_category_check" CHECK ((category = ANY (ARRAY['brews'::text, 'beans'::text, 'general'::text]))) not valid;
  end if;
end $$;

alter table "analytics"."raw_events_y2026m04" validate constraint "raw_events_category_check";

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'raw_events_platform_check' and conrelid = 'analytics.raw_events_y2026m04'::regclass
  ) then
    alter table "analytics"."raw_events_y2026m04" add constraint "raw_events_platform_check" CHECK ((platform = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text]))) not valid;
  end if;
end $$;

alter table "analytics"."raw_events_y2026m04" validate constraint "raw_events_platform_check";

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'raw_events_category_check' and conrelid = 'analytics.raw_events_y2026m05'::regclass
  ) then
    alter table "analytics"."raw_events_y2026m05" add constraint "raw_events_category_check" CHECK ((category = ANY (ARRAY['brews'::text, 'beans'::text, 'general'::text]))) not valid;
  end if;
end $$;

alter table "analytics"."raw_events_y2026m05" validate constraint "raw_events_category_check";

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'raw_events_platform_check' and conrelid = 'analytics.raw_events_y2026m05'::regclass
  ) then
    alter table "analytics"."raw_events_y2026m05" add constraint "raw_events_platform_check" CHECK ((platform = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text]))) not valid;
  end if;
end $$;

alter table "analytics"."raw_events_y2026m05" validate constraint "raw_events_platform_check";

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'raw_events_category_check' and conrelid = 'analytics.raw_events_y2026m06'::regclass
  ) then
    alter table "analytics"."raw_events_y2026m06" add constraint "raw_events_category_check" CHECK ((category = ANY (ARRAY['brews'::text, 'beans'::text, 'general'::text]))) not valid;
  end if;
end $$;

alter table "analytics"."raw_events_y2026m06" validate constraint "raw_events_category_check";

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'raw_events_platform_check' and conrelid = 'analytics.raw_events_y2026m06'::regclass
  ) then
    alter table "analytics"."raw_events_y2026m06" add constraint "raw_events_platform_check" CHECK ((platform = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text]))) not valid;
  end if;
end $$;

alter table "analytics"."raw_events_y2026m06" validate constraint "raw_events_platform_check";

set check_function_bodies = off;

create or replace view "analytics"."bmc_completed_supports" as  SELECT bmc_support_events.id,
    bmc_support_events.configured_event_type,
    bmc_support_events.received_at,
    bmc_support_events.match_status,
    bmc_support_events.candidate_count,
    bmc_support_events.matched_install_id,
    bmc_support_events.matched_platform,
    bmc_support_events.matched_button_event_id,
    bmc_support_events.matched_button_ts,
    (bmc_support_events.payload ->> 'type'::text) AS provider_type,
    (NULLIF((bmc_support_events.payload ->> 'live_mode'::text), ''::text))::boolean AS live_mode,
    (NULLIF(((bmc_support_events.payload -> 'data'::text) ->> 'amount'::text), ''::text))::numeric AS amount,
    ((bmc_support_events.payload -> 'data'::text) ->> 'currency'::text) AS currency,
    ((bmc_support_events.payload -> 'data'::text) ->> 'status'::text) AS provider_status,
    COALESCE(((bmc_support_events.payload -> 'data'::text) ->> 'transaction_id'::text), ((bmc_support_events.payload -> 'data'::text) ->> 'psp_id'::text)) AS provider_reference
   FROM analytics.bmc_support_events
  WHERE (bmc_support_events.configured_event_type = ANY (ARRAY['support_created'::text, 'monthly_support_started'::text]));


CREATE OR REPLACE FUNCTION analytics.maintain_partitions()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  next_month_start date := date_trunc('month', now() + interval '2 months')::date;
  next_month_end date := (date_trunc('month', now() + interval '2 months') + interval '1 month')::date;
  partition_suffix text := 'y' || to_char(next_month_start, 'YYYY') || 'm' || to_char(next_month_start, 'MM');
  old_month date := date_trunc('month', now() - interval '3 months')::date;
  old_suffix text := 'y' || to_char(old_month, 'YYYY') || 'm' || to_char(old_month, 'MM');
BEGIN
  -- Create next month's partition if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'analytics'
    AND tablename = 'raw_events_' || partition_suffix
  ) THEN
    EXECUTE format(
      'CREATE TABLE analytics.raw_events_%s PARTITION OF analytics.raw_events FOR VALUES FROM (%L) TO (%L)',
      partition_suffix, next_month_start, next_month_end
    );
  END IF;

  -- Drop partitions older than 90 days
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'analytics'
    AND tablename = 'raw_events_' || old_suffix
  ) THEN
    EXECUTE format('DROP TABLE analytics.raw_events_%s', old_suffix);
  END IF;
END
$function$
;

grant select on table "analytics"."bmc_support_events" to "anon";

grant select on table "analytics"."bmc_support_events" to "authenticated";

grant select on table "analytics"."bmc_support_events" to "grafana";

grant select on table "analytics"."bmc_support_events" to "service_role";

grant select on table "analytics"."daily_metrics" to "anon";

grant select on table "analytics"."daily_metrics" to "authenticated";

grant select on table "analytics"."daily_metrics" to "grafana";

grant select on table "analytics"."daily_metrics" to "service_role";

grant select on table "analytics"."raw_events" to "anon";

grant select on table "analytics"."raw_events" to "authenticated";

grant select on table "analytics"."raw_events" to "grafana";

grant select on table "analytics"."raw_events" to "service_role";

grant select on table "analytics"."raw_events_y2026m03" to "anon";

grant select on table "analytics"."raw_events_y2026m03" to "authenticated";

grant select on table "analytics"."raw_events_y2026m03" to "grafana";

grant select on table "analytics"."raw_events_y2026m03" to "service_role";

grant select on table "analytics"."raw_events_y2026m04" to "anon";

grant select on table "analytics"."raw_events_y2026m04" to "authenticated";

grant select on table "analytics"."raw_events_y2026m04" to "grafana";

grant select on table "analytics"."raw_events_y2026m04" to "service_role";

grant select on table "analytics"."raw_events_y2026m05" to "anon";

grant select on table "analytics"."raw_events_y2026m05" to "authenticated";

grant select on table "analytics"."raw_events_y2026m05" to "grafana";

grant select on table "analytics"."raw_events_y2026m05" to "service_role";

grant select on table "analytics"."raw_events_y2026m06" to "anon";

grant select on table "analytics"."raw_events_y2026m06" to "authenticated";

grant select on table "analytics"."raw_events_y2026m06" to "grafana";

grant select on table "analytics"."raw_events_y2026m06" to "service_role";


drop policy if exists "grafana_read_bmc_support_events" on "analytics"."bmc_support_events";

  create policy "grafana_read_bmc_support_events"
  on "analytics"."bmc_support_events"
  as permissive
  for select
  to grafana
using (true);



drop policy if exists "grafana_read_daily_metrics" on "analytics"."daily_metrics";

  create policy "grafana_read_daily_metrics"
  on "analytics"."daily_metrics"
  as permissive
  for select
  to grafana
using (true);



drop policy if exists "grafana_read_raw_events" on "analytics"."raw_events";

  create policy "grafana_read_raw_events"
  on "analytics"."raw_events"
  as permissive
  for select
  to grafana
using (true);







-- Removed: five `drop trigger` statements targeting Supabase Storage internals
-- (objects_*_prefix, prefixes_*_hierarchy). They were `supabase db diff` drift
-- artifacts against an older storage release, are owned by supabase_storage_admin,
-- and dropping them breaks the storage prefix hierarchy.

drop policy if exists "Users can delete their own bean photos" on "storage"."objects";

  create policy "Users can delete their own bean photos"
  on "storage"."objects"
  as permissive
  for delete
  to authenticated
using (((bucket_id = 'bean-photos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));



drop policy if exists "Users can read their own bean photos" on "storage"."objects";

  create policy "Users can read their own bean photos"
  on "storage"."objects"
  as permissive
  for select
  to authenticated
using (((bucket_id = 'bean-photos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));



drop policy if exists "Users can update their own bean photos" on "storage"."objects";

  create policy "Users can update their own bean photos"
  on "storage"."objects"
  as permissive
  for update
  to authenticated
using (((bucket_id = 'bean-photos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));



drop policy if exists "Users can upload their own bean photos" on "storage"."objects";

  create policy "Users can upload their own bean photos"
  on "storage"."objects"
  as permissive
  for insert
  to authenticated
with check (((bucket_id = 'bean-photos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));


do $$ begin
  CREATE TRIGGER protect_buckets_delete BEFORE DELETE ON storage.buckets FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();
exception
  when duplicate_object then null;
  -- The local dev stack runs migrations as `postgres`, which owns neither the
  -- storage schema nor storage.protect_delete(); skip rather than fail.
  when undefined_function or insufficient_privilege then null;
end $$;

do $$ begin
  CREATE TRIGGER protect_objects_delete BEFORE DELETE ON storage.objects FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();
exception
  when duplicate_object then null;
  -- The local dev stack runs migrations as `postgres`, which owns neither the
  -- storage schema nor storage.protect_delete(); skip rather than fail.
  when undefined_function or insufficient_privilege then null;
end $$;


