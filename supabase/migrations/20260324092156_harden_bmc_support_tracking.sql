-- Add CHECK constraints and unique indexes to bmc_support_events for data integrity
-- and idempotent webhook ingestion.

-- CHECK constraints
alter table "analytics"."bmc_support_events"
  add constraint "bmc_support_events_configured_event_type_check"
  CHECK ((configured_event_type = ANY (ARRAY[
    'support_created'::text,
    'support_refunded'::text,
    'monthly_support_started'::text,
    'monthly_support_updated'::text,
    'monthly_support_cancelled'::text
  ]))) not valid;
alter table "analytics"."bmc_support_events" validate constraint "bmc_support_events_configured_event_type_check";

alter table "analytics"."bmc_support_events"
  add constraint "bmc_support_events_match_status_check"
  CHECK ((match_status = ANY (ARRAY[
    'matched'::text, 'unmatched'::text, 'ambiguous'::text, 'not_applicable'::text
  ]))) not valid;
alter table "analytics"."bmc_support_events" validate constraint "bmc_support_events_match_status_check";

alter table "analytics"."bmc_support_events"
  add constraint "bmc_support_events_matched_platform_check"
  CHECK (((matched_platform IS NULL) OR (matched_platform = ANY (ARRAY[
    'ios'::text, 'android'::text, 'web'::text
  ])))) not valid;
alter table "analytics"."bmc_support_events" validate constraint "bmc_support_events_matched_platform_check";

alter table "analytics"."bmc_support_events"
  add constraint "bmc_support_events_candidate_count_check"
  CHECK ((candidate_count >= 0)) not valid;
alter table "analytics"."bmc_support_events" validate constraint "bmc_support_events_candidate_count_check";

-- Unique indexes for deduplication in insert_bmc_support_event
CREATE UNIQUE INDEX bmc_support_events_type_payload_sha256_idx
  ON analytics.bmc_support_events USING btree (configured_event_type, payload_sha256);

CREATE UNIQUE INDEX bmc_support_events_type_event_id_idx
  ON analytics.bmc_support_events USING btree (configured_event_type, ((payload ->> 'event_id'::text)))
  WHERE (payload ? 'event_id'::text);

-- Supporting indexes for common query patterns
CREATE INDEX bmc_support_events_received_at_idx
  ON analytics.bmc_support_events USING btree (received_at DESC);

CREATE INDEX bmc_support_events_type_received_at_idx
  ON analytics.bmc_support_events USING btree (configured_event_type, received_at DESC);

CREATE INDEX bmc_support_events_match_status_idx
  ON analytics.bmc_support_events USING btree (match_status, received_at DESC);

CREATE INDEX bmc_support_events_matched_install_id_idx
  ON analytics.bmc_support_events USING btree (matched_install_id)
  WHERE (matched_install_id IS NOT NULL);
