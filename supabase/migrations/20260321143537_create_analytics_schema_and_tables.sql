-- Create analytics schema for app event tracking
create schema if not exists "analytics";

-- Partitioned event log (partitioned by server_ts for efficient time-range queries)
create table "analytics"."raw_events" (
  "id"          uuid                     not null default gen_random_uuid(),
  "event_name"  text                     not null,
  "category"    text                     not null,
  "session_id"  uuid                     not null,
  "install_id"  text                     not null,
  "platform"    text                     not null,
  "app_version" text                     not null,
  "properties"  jsonb                             default '{}'::jsonb,
  "client_ts"   timestamp with time zone not null,
  "server_ts"   timestamp with time zone not null default now()
) partition by RANGE (server_ts);

alter table "analytics"."raw_events" enable row level security;

-- Daily aggregated metrics table
create table "analytics"."daily_metrics" (
  "date"         date                     not null,
  "platform"     text                     not null,
  "metric_name"  text                     not null,
  "metric_value" numeric                  not null default 0,
  "dimensions"   jsonb                    not null default '{}'::jsonb,
  "updated_at"   timestamp with time zone          default now()
);

alter table "analytics"."daily_metrics" enable row level security;

-- Initial partitions: current month + 3 months ahead
create table "analytics"."raw_events_y2026m03" partition of "analytics"."raw_events"
  for values from ('2026-03-01 00:00:00+00') to ('2026-04-01 00:00:00+00');

create table "analytics"."raw_events_y2026m04" partition of "analytics"."raw_events"
  for values from ('2026-04-01 00:00:00+00') to ('2026-05-01 00:00:00+00');

create table "analytics"."raw_events_y2026m05" partition of "analytics"."raw_events"
  for values from ('2026-05-01 00:00:00+00') to ('2026-06-01 00:00:00+00');

create table "analytics"."raw_events_y2026m06" partition of "analytics"."raw_events"
  for values from ('2026-06-01 00:00:00+00') to ('2026-07-01 00:00:00+00');

-- Primary keys and indexes (on parent, inherited by partitions)
CREATE UNIQUE INDEX raw_events_pkey         ON ONLY analytics.raw_events USING btree (id, server_ts);
CREATE INDEX idx_raw_events_event_name      ON ONLY analytics.raw_events USING btree (event_name, server_ts);
CREATE INDEX idx_raw_events_install_id      ON ONLY analytics.raw_events USING btree (install_id, server_ts);
CREATE INDEX idx_raw_events_category        ON ONLY analytics.raw_events USING btree (category, server_ts);

CREATE UNIQUE INDEX daily_metrics_pkey ON analytics.daily_metrics USING btree (date, platform, metric_name, dimensions);

alter table "analytics"."raw_events"    add constraint "raw_events_pkey"    PRIMARY KEY using index "raw_events_pkey";
alter table "analytics"."daily_metrics" add constraint "daily_metrics_pkey" PRIMARY KEY using index "daily_metrics_pkey";

alter table "analytics"."raw_events" add constraint "raw_events_category_check"
  CHECK ((category = ANY (ARRAY['brews'::text, 'beans'::text, 'general'::text]))) not valid;
alter table "analytics"."raw_events" validate constraint "raw_events_category_check";

alter table "analytics"."raw_events" add constraint "raw_events_platform_check"
  CHECK ((platform = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text]))) not valid;
alter table "analytics"."raw_events" validate constraint "raw_events_platform_check";

-- Grants
grant select on table "analytics"."raw_events"    to "anon";
grant select on table "analytics"."raw_events"    to "authenticated";
grant select on table "analytics"."raw_events"    to "grafana";
grant select on table "analytics"."raw_events"    to "service_role";

grant select on table "analytics"."daily_metrics" to "anon";
grant select on table "analytics"."daily_metrics" to "authenticated";
grant select on table "analytics"."daily_metrics" to "grafana";
grant select on table "analytics"."daily_metrics" to "service_role";

-- Grafana read policy (service_role bypasses RLS; anon/authenticated have no policies = no access)
create policy "grafana_read_raw_events"
on "analytics"."raw_events"
as permissive
for select
to grafana
using (true);

create policy "grafana_read_daily_metrics"
on "analytics"."daily_metrics"
as permissive
for select
to grafana
using (true);
