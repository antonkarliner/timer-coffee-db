\set ON_ERROR_STOP on
begin;

create function pg_temp.assert(ok boolean, msg text) returns void
language plpgsql set search_path = '' as $$
begin
  if ok is distinct from true then
    raise exception 'Assertion failed: %', msg;
  end if;
end;
$$;
revoke execute on function pg_temp.assert(boolean, text) from public;
revoke execute on function pg_temp.assert(boolean, text) from anon;
revoke execute on function pg_temp.assert(boolean, text) from authenticated;
grant execute on function pg_temp.assert(boolean, text) to service_role;
grant execute on function pg_temp.assert(boolean, text) to postgres;

select pg_temp.assert((
  select prosecdef
  from pg_catalog.pg_proc
  where oid = 'public.insert_bmc_support_event(text,jsonb,text,text)'::regprocedure
), 'ingestion RPC stays SECURITY DEFINER');
select pg_temp.assert((
  select proconfig = array['search_path=""']
  from pg_catalog.pg_proc
  where oid = 'public.insert_bmc_support_event(text,jsonb,text,text)'::regprocedure
), 'ingestion RPC keeps empty search_path');
select pg_temp.assert(not has_function_privilege(
  'anon', 'public.insert_bmc_support_event(text,jsonb,text,text)'::regprocedure, 'EXECUTE'
), 'anon cannot execute ingestion RPC');
select pg_temp.assert(not has_function_privilege(
  'authenticated', 'public.insert_bmc_support_event(text,jsonb,text,text)'::regprocedure, 'EXECUTE'
), 'authenticated cannot execute ingestion RPC');
select pg_temp.assert(has_function_privilege(
  'service_role', 'public.insert_bmc_support_event(text,jsonb,text,text)'::regprocedure, 'EXECUTE'
), 'service_role can execute ingestion RPC');

set local role service_role;
do $$
declare
  v_kind text;
  v_payload jsonb;
  v_sha text;
  v_first jsonb;
  v_duplicate jsonb;
begin
  foreach v_kind in array array['support_created', 'support_refunded', 'monthly_support_started', 'monthly_support_updated', 'monthly_support_cancelled']
  loop
    v_payload := jsonb_build_object('event_id', 'bmc-kinds-' || v_kind || '-' || gen_random_uuid(), 'type', 'synthetic.' || v_kind, 'live_mode', false, 'data', jsonb_build_object('amount', '1', 'currency', 'USD'));
    v_sha := encode(sha256(convert_to(v_payload::text, 'UTF8')), 'hex');
    v_first := public.insert_bmc_support_event(v_kind, v_payload, v_sha, 'synthetic-test-signature');
    perform pg_temp.assert(v_first->'inserted' = 'true'::jsonb,
      format('%s: first call inserts', v_kind));
    perform pg_temp.assert(v_first->>'event_id' is not null,
      format('%s: insertion returns event ID', v_kind));
    perform pg_temp.assert(v_first->>'match_status' is not null,
      format('%s: match_status is not null', v_kind));
    perform pg_temp.assert(v_first->>'candidate_count' is not null,
      format('%s: candidate_count is not null', v_kind));
    if v_kind in ('support_created', 'monthly_support_started') then
      perform pg_temp.assert(v_first->>'match_status' in ('matched', 'unmatched', 'ambiguous'),
        format('%s: creation runs donation-button correlation', v_kind));
    else
      perform pg_temp.assert(v_first->>'match_status' = 'not_applicable',
        format('%s: match_status default survives', v_kind));
      perform pg_temp.assert(v_first->'candidate_count' = '0'::jsonb,
        format('%s: candidate_count default survives', v_kind));
    end if;
    v_duplicate := public.insert_bmc_support_event(v_kind, v_payload, v_sha, 'synthetic-test-signature');
    perform pg_temp.assert(v_duplicate->'inserted' = 'false'::jsonb,
      format('%s: identical second call reports duplicate', v_kind));
    perform pg_temp.assert(v_duplicate->>'event_id' = v_first->>'event_id',
      format('%s: duplicate returns original event ID', v_kind));
    perform pg_temp.assert((v_duplicate - 'inserted') = (v_first - 'inserted'),
      format('%s: duplicate preserves correlation fields', v_kind));
  end loop;
end;
$$;
reset role;

rollback;
