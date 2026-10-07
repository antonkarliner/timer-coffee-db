\set ON_ERROR_STOP on
begin;

create function pg_temp.assert(ok boolean, msg text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'Assertion failed: %', msg; end if; end$$;

insert into auth.users (id, instance_id, aud, role, email, is_anonymous, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('f1300000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'f13-quota@example.invalid', true, '{}'::jsonb, '{}'::jsonb, now(), now());

select pg_temp.assert(not has_function_privilege('anon', 'service.reserve_label_parse_units(uuid,integer,integer,text)', 'EXECUTE'), 'anon cannot reserve');
select pg_temp.assert(not has_function_privilege('authenticated', 'service.reserve_label_parse_units(uuid,integer,integer,text)', 'EXECUTE'), 'authenticated cannot reserve');
select pg_temp.assert(has_function_privilege('service_role', 'service.reserve_label_parse_units(uuid,integer,integer,text)', 'EXECUTE'), 'service can reserve');
select pg_temp.assert(not has_function_privilege('anon', 'service.finalize_label_parse_reservation(bigint,text)', 'EXECUTE'), 'anon cannot finalize');
select pg_temp.assert(not has_function_privilege('authenticated', 'service.finalize_label_parse_reservation(bigint,text)', 'EXECUTE'), 'authenticated cannot finalize');
select pg_temp.assert(has_function_privilege('service_role', 'service.finalize_label_parse_reservation(bigint,text)', 'EXECUTE'), 'service can finalize');
select pg_temp.assert(not has_table_privilege('authenticated', 'public.parse_coffee_label_invocations', 'SELECT'), 'authenticated cannot read ledger');
select pg_temp.assert(not has_table_privilege('anon', 'public.parse_coffee_label_invocations', 'INSERT'), 'anon cannot insert ledger');
select pg_temp.assert(not has_table_privilege('authenticated', 'public.parse_coffee_label_invocations', 'TRUNCATE'), 'authenticated cannot truncate ledger');
select pg_temp.assert(not has_table_privilege('authenticated', 'public.pro_users', 'SELECT'), 'authenticated cannot read Pro table');
select pg_temp.assert(not has_table_privilege('anon', 'public.pro_users', 'UPDATE'), 'anon cannot mutate Pro table');
select pg_temp.assert(has_table_privilege('service_role', 'public.parse_coffee_label_invocations', 'SELECT,INSERT,UPDATE,DELETE'), 'service has ledger access');
select pg_temp.assert(has_table_privilege('service_role', 'public.pro_users', 'SELECT'), 'service can check Pro');
select pg_temp.assert(not has_sequence_privilege('anon', pg_get_serial_sequence('public.parse_coffee_label_invocations','id'), 'USAGE'), 'anon cannot use ledger sequence');
select pg_temp.assert(not has_sequence_privilege('authenticated', pg_get_serial_sequence('public.parse_coffee_label_invocations','id'), 'SELECT'), 'authenticated cannot read sequence');

set local role service_role;
insert into public.parse_coffee_label_invocations (user_id, invoked_at, tokens_used)
values ('f1300000-0000-4000-8000-000000000001', date_trunc('month', now(), 'UTC') - interval '1 second', 500);
select pg_temp.assert((select status = 'succeeded' from public.parse_coffee_label_invocations where user_id = 'f1300000-0000-4000-8000-000000000001'), 'old-code inserts default to succeeded');

do $$
declare r record; first_id bigint; second_id bigint; third_id bigint;
begin
  select * into r from service.reserve_label_parse_units('f1300000-0000-4000-8000-000000000001', 2, 4, 'primary');
  perform pg_temp.assert(r.admitted and r.used = 0 and r.reservation_id is not null, 'last month excluded');
  first_id := r.reservation_id;
  select * into r from service.reserve_label_parse_units('f1300000-0000-4000-8000-000000000001', 2, 4, 'gemini');
  perform pg_temp.assert(r.admitted and r.used = 2, 'reserved units counted across routes');
  second_id := r.reservation_id;
  select * into r from service.reserve_label_parse_units('f1300000-0000-4000-8000-000000000001', 1, 4, 'primary');
  perform pg_temp.assert(not r.admitted and r.used = 4 and r.reservation_id is null, 'one over limit refused');
  perform pg_temp.assert(service.finalize_label_parse_reservation(first_id, 'failed_billed'), 'failed provider billed');
  perform pg_temp.assert((select status = 'failed_billed' and completed_at is not null from public.parse_coffee_label_invocations where id = first_id), 'failure status and completion time');
  perform pg_temp.assert(not service.finalize_label_parse_reservation(first_id, 'released'), 'cannot release billed row');
  perform pg_temp.assert(not service.finalize_label_parse_reservation(first_id, 'succeeded'), 'cannot change finalized row');
  perform pg_temp.assert(service.finalize_label_parse_reservation(second_id, 'released'), 'undispatched reservation released');
  perform pg_temp.assert(not exists(select 1 from public.parse_coffee_label_invocations where id = second_id), 'released row deleted');
  perform pg_temp.assert(not service.finalize_label_parse_reservation(second_id, 'released'), 'repeat release false');
  select * into r from service.reserve_label_parse_units('f1300000-0000-4000-8000-000000000001', 2, 4, 'gemini');
  perform pg_temp.assert(r.admitted and r.used = 2, 'failed_billed counted, released excluded');
  third_id := r.reservation_id;
  perform pg_temp.assert(service.finalize_label_parse_reservation(third_id, 'succeeded'), 'success finalized');
  perform pg_temp.assert((select status = 'succeeded' and completed_at is not null from public.parse_coffee_label_invocations where id = third_id), 'success status and completion time');
  perform pg_temp.assert(not service.finalize_label_parse_reservation(third_id, 'failed_billed'), 'success immutable');
  select * into r from service.reserve_label_parse_units('f1300000-0000-4000-8000-000000000001', 1, 4, 'primary');
  perform pg_temp.assert(not r.admitted and r.used = 4, 'success and failed_billed remain charged');
end $$;

do $$ begin
  perform service.reserve_label_parse_units(null, 1, 4, 'primary');
  raise exception 'expected failure: null user';
exception when invalid_parameter_value then null; end $$;
do $$ begin
  perform service.reserve_label_parse_units('f1300000-0000-4000-8000-000000000001', 0, 4, 'primary');
  raise exception 'expected failure: zero units';
exception when invalid_parameter_value then null; end $$;
do $$ begin
  perform service.reserve_label_parse_units('f1300000-0000-4000-8000-000000000001', 3, 4, 'primary');
  raise exception 'expected failure: excessive units';
exception when invalid_parameter_value then null; end $$;
do $$ begin
  perform service.reserve_label_parse_units('f1300000-0000-4000-8000-000000000001', 1, 0, 'primary');
  raise exception 'expected failure: invalid limit';
exception when invalid_parameter_value then null; end $$;
do $$ begin
  perform service.reserve_label_parse_units('f1300000-0000-4000-8000-000000000001', 1, 4, 'unknown');
  raise exception 'expected failure: invalid route';
exception when invalid_parameter_value then null; end $$;
do $$ begin
  perform service.finalize_label_parse_reservation(0, 'unknown');
  raise exception 'expected failure: invalid outcome';
exception when invalid_parameter_value then null; end $$;

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"f1300000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$ begin
  perform * from public.parse_coffee_label_invocations;
  raise exception 'expected failure: authenticated read';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform service.reserve_label_parse_units('f1300000-0000-4000-8000-000000000001', 1, 4, 'primary');
  raise exception 'expected failure: authenticated RPC';
exception when insufficient_privilege then null; end $$;
reset role;
set local role anon;
do $$ begin
  perform service.finalize_label_parse_reservation(0, 'released');
  raise exception 'expected failure: anon RPC';
exception when insufficient_privilege then null; end $$;
reset role;
-- Advisory admission locking is covered structurally; true parallel database
-- sessions require an operator-run concurrency test, not this single session.
rollback;
