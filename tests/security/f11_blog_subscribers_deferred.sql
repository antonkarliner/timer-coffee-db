\set ON_ERROR_STOP on
-- Included after the deferred migration, inside the operator's transaction.
create function pg_temp.assert(ok boolean, msg text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'Assertion failed: %', msg; end if; end$$;

select pg_temp.assert(not has_function_privilege('anon', 'public.add_subscriber(text)', 'EXECUTE'), 'anon issuance retired');
select pg_temp.assert(not has_function_privilege('authenticated', 'public.add_subscriber(text)', 'EXECUTE'), 'authenticated issuance retired');
select pg_temp.assert(has_function_privilege('service_role', 'public.add_subscriber(text)', 'EXECUTE'), 'service issuance retained');
select pg_temp.assert(has_function_privilege('anon', 'public.confirm_subscription(uuid)', 'EXECUTE'), 'anon confirmation retained');
select pg_temp.assert(has_function_privilege('anon', 'public.unsubscribe_subscriber(uuid)', 'EXECUTE'), 'anon unsubscribe retained');

insert into public.blog_subscribers(email, token)
values ('f11-c2a-deferred-legacy@example.invalid', 'f1100000-0000-4000-8000-000000000002');
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select pg_temp.assert(not found and not already_confirmed, 'legacy token no longer confirms') from public.confirm_subscription('f1100000-0000-4000-8000-000000000002');
do $$ begin
  perform public.add_subscriber('f11-c2a-deferred-denied@example.invalid');
  raise exception 'expected failure: anon legacy issuance';
exception when insufficient_privilege then null; end $$;
reset role;
select pg_temp.assert(not confirmed, 'legacy row remains unconfirmed') from public.blog_subscribers where email = 'f11-c2a-deferred-legacy@example.invalid';

set local role service_role;
select pg_temp.assert(generated_token is not null, 'service can still issue') from public.add_subscriber('f11-c2a-deferred-service@example.invalid');
select set_config('test.f11_deferred_confirmation', confirmation_token::text, true) from public.request_blog_subscription('f11-c2a-deferred-modern@example.invalid');
reset role;
set local role anon;
select pg_temp.assert(found and not already_confirmed, 'modern confirmation still works') from public.confirm_subscription(current_setting('test.f11_deferred_confirmation')::uuid);
select pg_temp.assert(not found and not already_confirmed, 'modern replay still fails') from public.confirm_subscription(current_setting('test.f11_deferred_confirmation')::uuid);
reset role;
