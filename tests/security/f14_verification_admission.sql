\set ON_ERROR_STOP on
begin;
create function pg_temp.assert(ok boolean, msg text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'Assertion failed: %', msg; end if; end$$;

insert into auth.users (id, instance_id, aud, role, email, is_anonymous, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('f1400000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'f14-test@example.invalid', false, '{}', '{}', now(), now());

-- Isolate the global budget from any existing local fixtures; rolled back below.
delete from service.user_recipe_verification_invocations;

select pg_temp.assert(not has_table_privilege('anon', 'service.user_recipe_verification_invocations', 'SELECT'), 'anon cannot read ledger');
select pg_temp.assert(not has_table_privilege('authenticated', 'service.user_recipe_verification_invocations', 'SELECT'), 'authenticated cannot read ledger');
select pg_temp.assert(has_table_privilege('service_role', 'service.user_recipe_verification_invocations', 'SELECT, INSERT, UPDATE, DELETE'), 'service ledger privileges');
select pg_temp.assert(not has_sequence_privilege('anon', 'service.user_recipe_verification_invocations_id_seq', 'USAGE'), 'anon sequence revoked');
select pg_temp.assert(not has_sequence_privilege('authenticated', 'service.user_recipe_verification_invocations_id_seq', 'USAGE'), 'authenticated sequence revoked');
select pg_temp.assert(has_sequence_privilege('service_role', 'service.user_recipe_verification_invocations_id_seq', 'USAGE, SELECT'), 'service sequence privileges');
do $$
declare fn text; caller text;
begin
  foreach fn in array array[
    'service.admit_recipe_verification(uuid,integer,bigint,bigint)',
    'service.finalize_recipe_verification(bigint,text,bigint,bigint,text,text,boolean)'
  ] loop
    foreach caller in array array['anon', 'authenticated'] loop
      perform pg_temp.assert(not has_function_privilege(caller, fn, 'EXECUTE'), caller || ' cannot execute ' || fn);
    end loop;
    perform pg_temp.assert(has_function_privilege('service_role', fn, 'EXECUTE'), 'service can execute ' || fn);
  end loop;
end $$;

set local role service_role;
insert into service.user_recipe_verification_invocations
  (user_id, invoked_at, provider_used, provider_model_used, status)
values
  ('f1400000-0000-4000-8000-000000000001', now() - interval '59 minutes', 'test', 'test', 'failed'),
  ('f1400000-0000-4000-8000-000000000001', now() - interval '61 minutes', 'test', 'test', 'succeeded'),
  ('f1400000-0000-4000-8000-000000000001', now() - interval '1 hour', 'test', 'test', 'reserved');

do $$
declare a record; b record; saved record;
begin
  select * into a from service.admit_recipe_verification('f1400000-0000-4000-8000-000000000001', 2, 1000, 100);
  perform pg_temp.assert(a.admitted and a.openai_allowed, 'only 59-minute row counts (strict rolling boundary)');
  select * into b from service.admit_recipe_verification('f1400000-0000-4000-8000-000000000001', 2, 1000, 100);
  perform pg_temp.assert(not b.admitted and b.invocation_id is null and not b.openai_allowed, 'limit reached includes reservation and failed row');
  perform pg_temp.assert(service.finalize_recipe_verification(a.invocation_id, 'failed', 80, 60, null, null, false), 'finalize failed');
  select * into saved from service.user_recipe_verification_invocations where id = a.invocation_id;
  perform pg_temp.assert(saved.openai_tokens_reserved = 0 and saved.openai_tokens_used = 60 and saved.tokens_used = 80
    and saved.status = 'failed' and saved.completed_at = now() and saved.provider_used = 'pending', 'known billing releases reservation and null provider stays pending');
  perform pg_temp.assert(not service.finalize_recipe_verification(a.invocation_id, 'succeeded', 999, 999, 'other', 'other', true), 'repeat returns false');
  perform pg_temp.assert((select to_jsonb(v) = to_jsonb(saved) from service.user_recipe_verification_invocations v where id = a.invocation_id), 'repeat changes nothing');
end $$;

delete from service.user_recipe_verification_invocations;
insert into service.user_recipe_verification_invocations
  (user_id, invoked_at, provider_used, provider_model_used, openai_tokens_used, openai_tokens_reserved)
values
  ('f1400000-0000-4000-8000-000000000001', pg_catalog.date_trunc('day', now(), 'UTC') - interval '1 minute', 'test', 'test', 1000000, 1000000),
  ('f1400000-0000-4000-8000-000000000001', now(), 'test', 'test', 60, 30);

do $$
declare a record; b record;
begin
  select * into a from service.admit_recipe_verification('f1400000-0000-4000-8000-000000000001', 100, 100, 10);
  perform pg_temp.assert(a.admitted and a.openai_allowed, 'earlier UTC days ignored; exact budget admitted');
  select * into b from service.admit_recipe_verification('f1400000-0000-4000-8000-000000000001', 100, 100, 10);
  perform pg_temp.assert(b.admitted and not b.openai_allowed, 'used plus reserved plus reservation exceeds budget');
  perform pg_temp.assert((select openai_tokens_reserved = 0 from service.user_recipe_verification_invocations where id = b.invocation_id), 'denied OpenAI reserves zero');
  perform pg_temp.assert(service.finalize_recipe_verification(a.invocation_id, 'failed', 5, 5, 'openai', 'test', true), 'unknown finalize');
  perform pg_temp.assert((select openai_tokens_reserved = 10 and billing_unknown and completed_at = now() from service.user_recipe_verification_invocations where id = a.invocation_id), 'unknown billing retains reservation');
  perform pg_temp.assert(service.finalize_recipe_verification(b.invocation_id, 'succeeded', 10, 0, 'gemini', 'test', false), 'successful finalize');
end $$;

do $$ begin
  perform service.admit_recipe_verification(null, 10, 100, 10);
  raise exception 'expected failure: invalid admission';
exception when invalid_parameter_value then null; end $$;
do $$ begin
  perform service.finalize_recipe_verification(1, 'reserved', 0, 0, null, null, false);
  raise exception 'expected failure: invalid final status';
exception when invalid_parameter_value then null; end $$;
reset role;
rollback;
