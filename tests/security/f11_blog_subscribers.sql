\set ON_ERROR_STOP on
begin;

create function pg_temp.assert(ok boolean, msg text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'Assertion failed: %', msg; end if; end$$;

select pg_temp.assert(not has_function_privilege('anon', 'public.request_blog_subscription(text)', 'EXECUTE'), 'anon cannot request');
select pg_temp.assert(not has_function_privilege('authenticated', 'public.request_blog_subscription(text)', 'EXECUTE'), 'authenticated cannot request');
select pg_temp.assert(has_function_privilege('service_role', 'public.request_blog_subscription(text)', 'EXECUTE'), 'service can request');
select pg_temp.assert(has_function_privilege('anon', 'public.confirm_subscription(uuid)', 'EXECUTE'), 'anon can confirm');
select pg_temp.assert(has_function_privilege('anon', 'public.unsubscribe_subscriber(uuid)', 'EXECUTE'), 'anon can unsubscribe');
select pg_temp.assert(not has_function_privilege('authenticated', 'public.confirm_subscription(uuid)', 'EXECUTE'), 'authenticated cannot confirm');
select pg_temp.assert(not has_function_privilege('authenticated', 'public.unsubscribe_subscriber(uuid)', 'EXECUTE'), 'authenticated cannot unsubscribe');
select pg_temp.assert(has_function_privilege('service_role', 'public.confirm_subscription(uuid)', 'EXECUTE'), 'service can confirm');
select pg_temp.assert(has_function_privilege('service_role', 'public.unsubscribe_subscriber(uuid)', 'EXECUTE'), 'service can unsubscribe');
select pg_temp.assert(has_function_privilege('anon', 'public.add_subscriber(text)', 'EXECUTE'), 'legacy issuance remains callable');
select pg_temp.assert(not has_table_privilege('anon', 'public.blog_subscribers', 'SELECT'), 'anon cannot select');
select pg_temp.assert(not has_table_privilege('anon', 'public.blog_subscribers', 'INSERT'), 'anon cannot insert');
select pg_temp.assert(not has_table_privilege('authenticated', 'public.blog_subscribers', 'SELECT'), 'authenticated cannot select');
select pg_temp.assert(not has_table_privilege('authenticated', 'public.blog_subscribers', 'INSERT'), 'authenticated cannot insert');
select pg_temp.assert(has_table_privilege('service_role', 'public.blog_subscribers', 'SELECT,INSERT,UPDATE,DELETE'), 'service table access');

insert into auth.users (id, instance_id, aud, role, email, is_anonymous,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('f1100000-0000-4000-8000-000000000003',
  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'f11-c2a-user@example.invalid', false, '{}', '{}', now(), now());

set local role authenticated;
set local request.jwt.claims = '{"sub":"f1100000-0000-4000-8000-000000000003","role":"authenticated"}';
do $$ begin
  perform public.request_blog_subscription('f11-c2a-auth-denied@example.invalid');
  raise exception 'expected failure: authenticated request RPC';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform 1 from public.blog_subscribers;
  raise exception 'expected failure: authenticated select';
exception when insufficient_privilege then null; end $$;
reset role;

set local role service_role;
do $$
declare
  first_request record;
  second_request record;
  confirmed_request record;
  result record;
begin
  select * into first_request from public.request_blog_subscription('  F11-C2A-Pending@example.invalid  ');
  perform pg_temp.assert(first_request.should_send and first_request.confirmation_token is not null and first_request.unsubscribe_token is not null, 'pending request returns tokens');
  perform pg_temp.assert(first_request.confirmation_token <> first_request.unsubscribe_token, 'credentials are distinct');
  perform pg_temp.assert(exists(select 1 from public.blog_subscribers where email = 'f11-c2a-pending@example.invalid' and not confirmed and confirmation_token_expires_at = now() + interval '7 days'), 'normalized pending row and expiry');

  select * into second_request from public.request_blog_subscription('f11-c2a-pending@example.invalid');
  perform pg_temp.assert(second_request.should_send and second_request.confirmation_token <> first_request.confirmation_token and second_request.unsubscribe_token = first_request.unsubscribe_token, 'only confirmation rotates');
  select * into result from public.confirm_subscription(first_request.confirmation_token);
  perform pg_temp.assert(not result.found and not result.already_confirmed, 'rotated link fails');
  select * into result from public.confirm_subscription(second_request.unsubscribe_token);
  perform pg_temp.assert(not result.found and not result.already_confirmed, 'unsubscribe token cannot confirm pending row');
  perform pg_temp.assert(not public.unsubscribe_subscriber(second_request.confirmation_token), 'confirmation token cannot unsubscribe');

  select * into result from public.confirm_subscription(second_request.confirmation_token);
  perform pg_temp.assert(result.found and not result.already_confirmed, 'confirmation succeeds');
  perform pg_temp.assert(exists(select 1 from public.blog_subscribers where email = 'f11-c2a-pending@example.invalid' and confirmed and confirmation_token is null and confirmation_token_expires_at is null), 'confirmation consumes token');
  select * into result from public.confirm_subscription(second_request.confirmation_token);
  perform pg_temp.assert(not result.found and not result.already_confirmed, 'confirmation replay fails');

  select * into confirmed_request from public.request_blog_subscription('f11-c2a-pending@example.invalid');
  perform pg_temp.assert(not confirmed_request.should_send and confirmed_request.confirmation_token is null and confirmed_request.unsubscribe_token is null, 'confirmed response hides tokens');
  perform pg_temp.assert(exists(select 1 from public.blog_subscribers where email = 'f11-c2a-pending@example.invalid' and confirmed and token = first_request.unsubscribe_token and confirmation_token is null and confirmation_token_expires_at is null), 'confirmed request changes nothing');

  select * into first_request from public.request_blog_subscription('f11-c2a-expired@example.invalid');
  update public.blog_subscribers set confirmation_token_expires_at = now() - interval '1 second' where email = 'f11-c2a-expired@example.invalid';
  select * into result from public.confirm_subscription(first_request.confirmation_token);
  perform pg_temp.assert(not result.found and not result.already_confirmed, 'expired confirmation fails');
  perform pg_temp.assert(exists(select 1 from public.blog_subscribers where email = 'f11-c2a-expired@example.invalid' and not confirmed), 'expired row remains pending');

  select * into first_request from public.request_blog_subscription('f11-c2a-unsubscribe@example.invalid');
  perform pg_temp.assert(public.unsubscribe_subscriber(first_request.unsubscribe_token), 'unsubscribe matches');
  perform pg_temp.assert(exists(select 1 from public.blog_subscribers where email = 'f11-c2a-unsubscribe@example.invalid' and not confirmed and confirmation_token is null and confirmation_token_expires_at is null), 'unsubscribe clears pending credential');
  select * into result from public.confirm_subscription(first_request.confirmation_token);
  perform pg_temp.assert(not result.found and not result.already_confirmed, 'old confirm link cannot resubscribe');

  select * into first_request from public.request_blog_subscription('f11-c2a-anon@example.invalid');
  perform set_config('test.f11_confirmation', first_request.confirmation_token::text, true);
  perform set_config('test.f11_unsubscribe', first_request.unsubscribe_token::text, true);
end;
$$;

-- Invalid SQL input fails with exactly invalid_parameter_value (22023).
do $$ begin
  perform public.request_blog_subscription('  ');
  raise exception 'expected failure: empty email';
exception when invalid_parameter_value then null; end $$;
do $$ begin
  perform public.request_blog_subscription(null);
  raise exception 'expected failure: null email';
exception when invalid_parameter_value then null; end $$;
do $$ begin
  perform public.request_blog_subscription(repeat('x', 255) || '@');
  raise exception 'expected failure: long email';
exception when invalid_parameter_value then null; end $$;
do $$ begin
  perform public.request_blog_subscription('no-at-sign');
  raise exception 'expected failure: missing at sign';
exception when invalid_parameter_value then null; end $$;
reset role;

set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
do $$
declare result record;
begin
  select * into result from public.confirm_subscription(current_setting('test.f11_confirmation')::uuid);
  perform pg_temp.assert(result.found and not result.already_confirmed, 'anon confirmation endpoint works');
  perform pg_temp.assert(public.unsubscribe_subscriber(current_setting('test.f11_unsubscribe')::uuid), 'anon unsubscribe endpoint works');
end;
$$;
do $$ begin
  perform public.request_blog_subscription('f11-c2a-denied@example.invalid');
  raise exception 'expected failure: anon request RPC';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform 1 from public.blog_subscribers;
  raise exception 'expected failure: anon select';
exception when insufficient_privilege then null; end $$;
do $$ begin
  insert into public.blog_subscribers(email) values ('f11-c2a-denied@example.invalid');
  raise exception 'expected failure: anon insert';
exception when insufficient_privilege then null; end $$;
reset role;

-- Transition compatibility for a legacy mailbox confirmation link.
insert into public.blog_subscribers(email, token) values ('f11-c2a-legacy@example.invalid', 'f1100000-0000-4000-8000-000000000001');
select pg_temp.assert(found and not already_confirmed, 'legacy link confirms') from public.confirm_subscription('f1100000-0000-4000-8000-000000000001');
select pg_temp.assert(found and already_confirmed, 'legacy confirmed link reports state') from public.confirm_subscription('f1100000-0000-4000-8000-000000000001');

rollback;
