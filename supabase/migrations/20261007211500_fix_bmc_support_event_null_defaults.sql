-- A new event whose payload carries event_id ran the duplicate check's
-- SELECT ... INTO against no row, which sets every INTO target to NULL. Only
-- support_created and monthly_support_started re-assign match_status and
-- candidate_count afterwards, so refund and monthly update/cancel webhooks wrote
-- NULL into NOT NULL columns and buymeacoffee-webhook answered 500. The
-- duplicate check now selects into its own locals; the body is otherwise
-- unchanged. CREATE OR REPLACE resets proconfig, so SECURITY DEFINER and
-- search_path are re-declared, and the service-only grants from
-- 20261007110000_restrict_bmc_ingestion_rpc.sql are re-asserted.

CREATE OR REPLACE FUNCTION public.insert_bmc_support_event(p_configured_event_type text, p_payload jsonb, p_payload_sha256 text, p_signature_header text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_event_id uuid;
  v_received_at timestamptz := now();
  v_candidate_count integer := 0;
  v_match_status text := 'not_applicable';
  v_matched_install_id text;
  v_matched_platform text;
  v_matched_button_event_id uuid;
  v_matched_button_ts timestamptz;
  v_provider_event_id text := nullif(p_payload->>'event_id', '');
  v_existing_event_id uuid;
  v_existing_candidate_count integer;
  v_existing_match_status text;
  v_existing_matched_install_id text;
  v_existing_matched_platform text;
  v_existing_matched_button_event_id uuid;
  v_existing_matched_button_ts timestamptz;
begin
  if v_provider_event_id is not null then
    -- Own locals: SELECT INTO with no matching row sets every target to NULL,
    -- which would erase the 'not_applicable' / 0 defaults the update relies on.
    select
      id,
      candidate_count,
      match_status,
      matched_install_id,
      matched_platform,
      matched_button_event_id,
      matched_button_ts
    into
      v_existing_event_id,
      v_existing_candidate_count,
      v_existing_match_status,
      v_existing_matched_install_id,
      v_existing_matched_platform,
      v_existing_matched_button_event_id,
      v_existing_matched_button_ts
    from analytics.bmc_support_events
    where configured_event_type = p_configured_event_type
      and payload->>'event_id' = v_provider_event_id
    limit 1;

    if v_existing_event_id is not null then
      return jsonb_build_object(
        'inserted', false,
        'event_id', v_existing_event_id,
        'match_status', v_existing_match_status,
        'candidate_count', v_existing_candidate_count,
        'matched_install_id', v_existing_matched_install_id,
        'matched_platform', v_existing_matched_platform,
        'matched_button_event_id', v_existing_matched_button_event_id,
        'matched_button_ts', v_existing_matched_button_ts
      );
    end if;
  end if;

  insert into analytics.bmc_support_events (
    configured_event_type,
    received_at,
    payload,
    payload_sha256,
    signature_header
  )
  values (
    p_configured_event_type,
    v_received_at,
    p_payload,
    p_payload_sha256,
    p_signature_header
  )
  on conflict do nothing
  returning id into v_event_id;

  if v_event_id is null then
    select
      id,
      candidate_count,
      match_status,
      matched_install_id,
      matched_platform,
      matched_button_event_id,
      matched_button_ts
    into
      v_event_id,
      v_candidate_count,
      v_match_status,
      v_matched_install_id,
      v_matched_platform,
      v_matched_button_event_id,
      v_matched_button_ts
    from analytics.bmc_support_events
    where configured_event_type = p_configured_event_type
      and (
        (v_provider_event_id is not null and payload->>'event_id' = v_provider_event_id)
        or payload_sha256 = p_payload_sha256
      )
    order by received_at desc
    limit 1;

    return jsonb_build_object(
      'inserted', false,
      'event_id', v_event_id,
      'match_status', v_match_status,
      'candidate_count', v_candidate_count,
      'matched_install_id', v_matched_install_id,
      'matched_platform', v_matched_platform,
      'matched_button_event_id', v_matched_button_event_id,
      'matched_button_ts', v_matched_button_ts
    );
  end if;

  if p_configured_event_type in ('support_created', 'monthly_support_started') then
    select count(*)::integer
    into v_candidate_count
    from analytics.raw_events
    where event_name = 'donation_button_tapped'
      and properties->>'product_id' = 'buymeacoffee_external'
      and server_ts between v_received_at - interval '10 minutes' and v_received_at;

    if v_candidate_count = 1 then
      v_match_status := 'matched';

      select
        install_id,
        platform,
        id,
        server_ts
      into
        v_matched_install_id,
        v_matched_platform,
        v_matched_button_event_id,
        v_matched_button_ts
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
    match_status = v_match_status,
    candidate_count = v_candidate_count,
    matched_install_id = v_matched_install_id,
    matched_platform = v_matched_platform,
    matched_button_event_id = v_matched_button_event_id,
    matched_button_ts = v_matched_button_ts
  where id = v_event_id;

  return jsonb_build_object(
    'inserted', true,
    'event_id', v_event_id,
    'match_status', v_match_status,
    'candidate_count', v_candidate_count,
    'matched_install_id', v_matched_install_id,
    'matched_platform', v_matched_platform,
    'matched_button_event_id', v_matched_button_event_id,
    'matched_button_ts', v_matched_button_ts
  );
end;
$function$
;

revoke execute on function public.insert_bmc_support_event(text, jsonb, text, text) from public;
revoke execute on function public.insert_bmc_support_event(text, jsonb, text, text) from anon;
revoke execute on function public.insert_bmc_support_event(text, jsonb, text, text) from authenticated;
grant execute on function public.insert_bmc_support_event(text, jsonb, text, text) to service_role;
grant execute on function public.insert_bmc_support_event(text, jsonb, text, text) to postgres;
