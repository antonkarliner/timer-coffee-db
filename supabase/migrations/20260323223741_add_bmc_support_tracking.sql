-- Track Buy Me a Coffee webhook events and correlate them with in-app donation button taps.

create table "analytics"."bmc_support_events" (
  "id"                       uuid                     not null default gen_random_uuid(),
  "configured_event_type"    text                     not null,
  "received_at"              timestamp with time zone not null default now(),
  "payload"                  jsonb                    not null,
  "payload_sha256"           text                     not null,
  "signature_header"         text,
  "match_status"             text                     not null default 'not_applicable'::text,
  "candidate_count"          integer                  not null default 0,
  "matched_install_id"       text,
  "matched_platform"         text,
  "matched_button_event_id"  uuid,
  "matched_button_ts"        timestamp with time zone
);

alter table "analytics"."bmc_support_events" enable row level security;

CREATE UNIQUE INDEX bmc_support_events_pkey ON analytics.bmc_support_events USING btree (id);

alter table "analytics"."bmc_support_events"
  add constraint "bmc_support_events_pkey" PRIMARY KEY using index "bmc_support_events_pkey";

-- View: completed support events with flattened payload fields for easy querying
set check_function_bodies = off;

create or replace view "analytics"."bmc_completed_supports" as
  SELECT
    bmc_support_events.id,
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
    COALESCE(
      ((bmc_support_events.payload -> 'data'::text) ->> 'transaction_id'::text),
      ((bmc_support_events.payload -> 'data'::text) ->> 'psp_id'::text)
    ) AS provider_reference
  FROM analytics.bmc_support_events
  WHERE (bmc_support_events.configured_event_type = ANY (ARRAY['support_created'::text, 'monthly_support_started'::text]));

-- Security-definer function for the buymeacoffee-webhook edge function.
-- Idempotent: deduplicates by event_id or payload hash, then attempts to match
-- the BMC event to an in-app donation_button_tapped analytics event.
CREATE OR REPLACE FUNCTION public.insert_bmc_support_event(
  p_configured_event_type text,
  p_payload               jsonb,
  p_payload_sha256        text,
  p_signature_header      text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_event_id              uuid;
  v_received_at           timestamptz := now();
  v_candidate_count       integer := 0;
  v_match_status          text := 'not_applicable';
  v_matched_install_id    text;
  v_matched_platform      text;
  v_matched_button_event_id uuid;
  v_matched_button_ts     timestamptz;
  v_provider_event_id     text := nullif(p_payload->>'event_id', '');
begin
  -- Deduplicate by provider event_id if present
  if v_provider_event_id is not null then
    select
      id, candidate_count, match_status,
      matched_install_id, matched_platform,
      matched_button_event_id, matched_button_ts
    into
      v_event_id, v_candidate_count, v_match_status,
      v_matched_install_id, v_matched_platform,
      v_matched_button_event_id, v_matched_button_ts
    from analytics.bmc_support_events
    where configured_event_type = p_configured_event_type
      and payload->>'event_id' = v_provider_event_id
    limit 1;

    if v_event_id is not null then
      return jsonb_build_object(
        'inserted', false, 'event_id', v_event_id,
        'match_status', v_match_status, 'candidate_count', v_candidate_count,
        'matched_install_id', v_matched_install_id, 'matched_platform', v_matched_platform,
        'matched_button_event_id', v_matched_button_event_id, 'matched_button_ts', v_matched_button_ts
      );
    end if;
  end if;

  insert into analytics.bmc_support_events (
    configured_event_type, received_at, payload, payload_sha256, signature_header
  )
  values (
    p_configured_event_type, v_received_at, p_payload, p_payload_sha256, p_signature_header
  )
  on conflict do nothing
  returning id into v_event_id;

  -- Handle SHA256 conflict (already inserted)
  if v_event_id is null then
    select
      id, candidate_count, match_status,
      matched_install_id, matched_platform,
      matched_button_event_id, matched_button_ts
    into
      v_event_id, v_candidate_count, v_match_status,
      v_matched_install_id, v_matched_platform,
      v_matched_button_event_id, v_matched_button_ts
    from analytics.bmc_support_events
    where configured_event_type = p_configured_event_type
      and (
        (v_provider_event_id is not null and payload->>'event_id' = v_provider_event_id)
        or payload_sha256 = p_payload_sha256
      )
    order by received_at desc
    limit 1;

    return jsonb_build_object(
      'inserted', false, 'event_id', v_event_id,
      'match_status', v_match_status, 'candidate_count', v_candidate_count,
      'matched_install_id', v_matched_install_id, 'matched_platform', v_matched_platform,
      'matched_button_event_id', v_matched_button_event_id, 'matched_button_ts', v_matched_button_ts
    );
  end if;

  -- Attempt to match to an in-app donation_button_tapped event within ±10 minutes
  if p_configured_event_type in ('support_created', 'monthly_support_started') then
    select count(*)::integer
    into v_candidate_count
    from analytics.raw_events
    where event_name = 'donation_button_tapped'
      and properties->>'product_id' = 'buymeacoffee_external'
      and server_ts between v_received_at - interval '10 minutes' and v_received_at;

    if v_candidate_count = 1 then
      v_match_status := 'matched';
      select install_id, platform, id, server_ts
      into v_matched_install_id, v_matched_platform, v_matched_button_event_id, v_matched_button_ts
      from analytics.raw_events
      where event_name = 'donation_button_tapped'
        and properties->>'product_id' = 'buymeacoffee_external'
        and server_ts between v_received_at - interval '10 minutes' and v_received_at
      order by server_ts desc
      limit 1;
    elsif v_candidate_count = 0 then
      v_match_status := 'unmatched';
    else
      v_match_status := 'ambiguous';
    end if;
  end if;

  update analytics.bmc_support_events
  set
    match_status             = v_match_status,
    candidate_count          = v_candidate_count,
    matched_install_id       = v_matched_install_id,
    matched_platform         = v_matched_platform,
    matched_button_event_id  = v_matched_button_event_id,
    matched_button_ts        = v_matched_button_ts
  where id = v_event_id;

  return jsonb_build_object(
    'inserted', true, 'event_id', v_event_id,
    'match_status', v_match_status, 'candidate_count', v_candidate_count,
    'matched_install_id', v_matched_install_id, 'matched_platform', v_matched_platform,
    'matched_button_event_id', v_matched_button_event_id, 'matched_button_ts', v_matched_button_ts
  );
end;
$function$;

-- Grants
grant select on table "analytics"."bmc_support_events" to "anon";
grant select on table "analytics"."bmc_support_events" to "authenticated";
grant select on table "analytics"."bmc_support_events" to "grafana";
grant select on table "analytics"."bmc_support_events" to "service_role";

create policy "grafana_read_bmc_support_events"
on "analytics"."bmc_support_events"
as permissive
for select
to grafana
using (true);
