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

select pg_temp.assert(not has_function_privilege(
  'anon', 'public.insert_bmc_support_event(text,jsonb,text,text)', 'EXECUTE'
), 'anon cannot execute ingestion RPC');
select pg_temp.assert(not has_function_privilege(
  'authenticated', 'public.insert_bmc_support_event(text,jsonb,text,text)', 'EXECUTE'
), 'authenticated cannot execute ingestion RPC');
select pg_temp.assert(has_function_privilege(
  'service_role', 'public.insert_bmc_support_event(text,jsonb,text,text)', 'EXECUTE'
), 'service_role can execute ingestion RPC');
select pg_temp.assert(has_function_privilege(
  'postgres', 'public.insert_bmc_support_event(text,jsonb,text,text)', 'EXECUTE'
), 'postgres can execute ingestion RPC');
select pg_temp.assert(not exists (
  select 1
  from pg_catalog.pg_proc p,
       lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
  where p.oid = 'public.insert_bmc_support_event(text,jsonb,text,text)'::regprocedure
    and a.grantee = 0
), 'no PUBLIC ACL entry remains');

set local role anon;
do $$
begin
  perform public.insert_bmc_support_event(
    'support_refunded', '{"event_id":"security-f03-denied"}'::jsonb,
    repeat('a', 64), null
  );
  raise exception 'expected failure: anon direct ingestion';
exception when insufficient_privilege then
  null;
end;
$$;
reset role;

set local role service_role;
do $$
declare
  first_result jsonb;
  duplicate_result jsonb;
  payload constant jsonb := '{"event_id":"security-f03-bmc-synthetic-20261007","type":"donation.created","live_mode":false,"data":{"amount":"1","currency":"USD"}}'::jsonb;
begin
  -- support_created is the only kind production has received since the
  -- function's 2026-03-25 definition. bmc_support_event_kinds.sql covers all
  -- five kinds; until 20261007211500 the others failed on NOT NULL match_status.
  first_result := public.insert_bmc_support_event(
    'support_created', payload, repeat('b', 64), 'synthetic-test-signature'
  );
  perform pg_temp.assert(first_result->'inserted' = 'true'::jsonb,
    'service_role inserts synthetic event');
  perform pg_temp.assert(first_result->>'event_id' is not null,
    'insertion returns event ID');
  perform pg_temp.assert(first_result->>'match_status' in ('matched', 'unmatched', 'ambiguous'),
    'creation runs donation-button correlation');
  duplicate_result := public.insert_bmc_support_event(
    'support_created', payload, repeat('b', 64), 'synthetic-test-signature'
  );
  perform pg_temp.assert(duplicate_result->'inserted' = 'false'::jsonb,
    'identical second call reports duplicate');
  perform pg_temp.assert(duplicate_result->>'event_id' = first_result->>'event_id',
    'duplicate returns original event ID');
  perform pg_temp.assert((duplicate_result - 'inserted') = (first_result - 'inserted'),
    'duplicate preserves correlation fields');
end;
$$;
reset role;

rollback;
