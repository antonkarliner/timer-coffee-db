\set ON_ERROR_STOP on

-- Run as postgres against the full local database with all migrations applied.
-- All fixtures and assertions are rolled back; no real users are used.
begin;

create function pg_temp.assert(ok boolean, msg text) returns void
language plpgsql
set search_path = ''
as $$begin if ok is distinct from true then raise exception 'Assertion failed: %', msg; end if; end$$;

revoke execute on function pg_temp.assert(boolean, text) from public;
revoke execute on function pg_temp.assert(boolean, text) from anon;
revoke execute on function pg_temp.assert(boolean, text) from authenticated;
grant execute on function pg_temp.assert(boolean, text) to service_role;
grant execute on function pg_temp.assert(boolean, text) to postgres;

insert into auth.users
    (id, instance_id, aud, role, email, is_anonymous, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
    ('a1020000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'f02-a@example.invalid', false, '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('b1020000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'f02-b@example.invalid', false, '{}'::jsonb, '{}'::jsonb, now(), now());

-- Satisfy the recipe FK without relying on reference-table seed data.
insert into public.brewing_methods (brewing_method_id, brewing_method, show_on_main)
values ('f02-test', 'F02 synthetic brewing method', false);

insert into public.user_recipes
    (id, vendor_id, brewing_method_id, coffee_amount, water_amount, water_temp, brew_time, ispublic, is_deleted)
values ('usr-a1020000-0000-4000-8000-000000000001-pub', 'usr-a1020000-0000-4000-8000-000000000001', 'f02-test', 15, 250, 93, 180, true, false);

insert into public.user_stats (user_id, stat_uuid, recipe_id, is_deleted)
values
    ('a1020000-0000-4000-8000-000000000001', 'f02-a-pub', 'usr-a1020000-0000-4000-8000-000000000001-pub', false),
    ('b1020000-0000-4000-8000-000000000002', 'f02-b-pub', 'usr-a1020000-0000-4000-8000-000000000001-pub', false),
    ('b1020000-0000-4000-8000-000000000002', 'f02-b-pub-deleted', 'usr-a1020000-0000-4000-8000-000000000001-pub', true),
    ('b1020000-0000-4000-8000-000000000002', 'f02-b-builtin', '101', false),
    ('a1020000-0000-4000-8000-000000000001', 'f02-a-gone', 'usr-a1020000-0000-4000-8000-000000000001-gone', false),
    ('b1020000-0000-4000-8000-000000000002', 'f02-b-gone', 'usr-a1020000-0000-4000-8000-000000000001-gone', false);

insert into public.user_recipe_preferences (user_id, recipe_id, is_favorite)
values
    ('a1020000-0000-4000-8000-000000000001', 'usr-a1020000-0000-4000-8000-000000000001-pub', true),
    ('b1020000-0000-4000-8000-000000000002', 'usr-a1020000-0000-4000-8000-000000000001-pub', true),
    ('b1020000-0000-4000-8000-000000000002', '101', true),
    ('a1020000-0000-4000-8000-000000000001', 'usr-a1020000-0000-4000-8000-000000000001-gone', true),
    ('b1020000-0000-4000-8000-000000000002', 'usr-a1020000-0000-4000-8000-000000000001-gone', true);

-- Namespace attacks must fail at the write boundary, even with A's allowed vendor_id.

set local role authenticated;
set local request.jwt.claims = '{"sub":"a1020000-0000-4000-8000-000000000001","role":"authenticated"}';

do $$
begin
    insert into public.user_recipes
        (id, vendor_id, brewing_method_id, coffee_amount, water_amount, water_temp, brew_time, ispublic, is_deleted)
    values ('101', 'usr-a1020000-0000-4000-8000-000000000001', 'f02-test', 15, 250, 93, 180, false, true);
    raise exception 'expected failure: built-in-shaped ID';
exception when check_violation then null;
end $$;

do $$
begin
    insert into public.user_recipes
        (id, vendor_id, brewing_method_id, coffee_amount, water_amount, water_temp, brew_time, ispublic, is_deleted)
    values ('usr-b1020000-0000-4000-8000-000000000002-x', 'usr-a1020000-0000-4000-8000-000000000001', 'f02-test', 15, 250, 93, 180, false, true);
    raise exception 'expected failure: another owner namespace';
exception when check_violation then null;
end $$;

do $$
begin
    insert into public.user_recipes
        (id, vendor_id, brewing_method_id, coffee_amount, water_amount, water_temp, brew_time, ispublic, is_deleted)
    values ('usr-a1020000-0000-4000-8000-000000000001-', 'usr-a1020000-0000-4000-8000-000000000001', 'f02-test', 15, 250, 93, 180, false, true);
    raise exception 'expected failure: empty suffix';
exception when check_violation then null;
end $$;

reset role;

select pg_temp.assert(
    (select is_deleted is false from public.user_stats
     where user_id = 'b1020000-0000-4000-8000-000000000002' and stat_uuid = 'f02-b-builtin'),
    'B built-in stats remain active'
);

select pg_temp.assert(
    exists (select 1 from public.user_recipe_preferences
                where user_id = 'b1020000-0000-4000-8000-000000000002' and recipe_id = '101'),
    'B built-in preference remains'
);

-- Deleting a public recipe affects only its creator, including preference deletion.

set local role authenticated;
set local request.jwt.claims = '{"sub":"a1020000-0000-4000-8000-000000000001","role":"authenticated"}';

update public.user_recipes set is_deleted = true where id = 'usr-a1020000-0000-4000-8000-000000000001-pub';

reset role;

select pg_temp.assert(
    (select is_deleted is true from public.user_stats
     where user_id = 'a1020000-0000-4000-8000-000000000001' and stat_uuid = 'f02-a-pub'),
    'A stats are soft-deleted'
);

select pg_temp.assert(
    not exists (select 1 from public.user_recipe_preferences
                where user_id = 'a1020000-0000-4000-8000-000000000001' and recipe_id = 'usr-a1020000-0000-4000-8000-000000000001-pub'),
    'A preference is deleted'
);

select pg_temp.assert(
    (select is_deleted is false from public.user_stats
     where user_id = 'b1020000-0000-4000-8000-000000000002' and stat_uuid = 'f02-b-pub'),
    'B active stats survive creator deletion'
);

select pg_temp.assert(
    (select is_deleted is true from public.user_stats
     where user_id = 'b1020000-0000-4000-8000-000000000002' and stat_uuid = 'f02-b-pub-deleted'),
    'B self-deleted stats stay deleted'
);

select pg_temp.assert(
    exists (select 1 from public.user_recipe_preferences
                where user_id = 'b1020000-0000-4000-8000-000000000002' and recipe_id = 'usr-a1020000-0000-4000-8000-000000000001-pub'),
    'B preference survives creator deletion'
);

select pg_temp.assert(
    (select is_deleted is false from public.user_stats
     where user_id = 'b1020000-0000-4000-8000-000000000002' and stat_uuid = 'f02-b-builtin'),
    'B built-in stats remain active'
);

select pg_temp.assert(
    exists (select 1 from public.user_recipe_preferences
                where user_id = 'b1020000-0000-4000-8000-000000000002' and recipe_id = '101'),
    'B built-in preference remains'
);

-- Restoration must not restore B's self-deleted brew.

set local role authenticated;
set local request.jwt.claims = '{"sub":"a1020000-0000-4000-8000-000000000001","role":"authenticated"}';

update public.user_recipes set is_deleted = false where id = 'usr-a1020000-0000-4000-8000-000000000001-pub';

reset role;

select pg_temp.assert(
    (select is_deleted is false from public.user_stats
     where user_id = 'a1020000-0000-4000-8000-000000000001' and stat_uuid = 'f02-a-pub'),
    'A stats are restored'
);

select pg_temp.assert(
    not exists (select 1 from public.user_recipe_preferences
                where user_id = 'a1020000-0000-4000-8000-000000000001' and recipe_id = 'usr-a1020000-0000-4000-8000-000000000001-pub'),
    'Restoration does not recreate A preference'
);

select pg_temp.assert(
    (select is_deleted is false from public.user_stats
     where user_id = 'b1020000-0000-4000-8000-000000000002' and stat_uuid = 'f02-b-pub'),
    'B active stats remain active after restoration'
);

select pg_temp.assert(
    (select is_deleted is true from public.user_stats
     where user_id = 'b1020000-0000-4000-8000-000000000002' and stat_uuid = 'f02-b-pub-deleted'),
    'B self-deleted stats are not restored'
);

select pg_temp.assert(
    exists (select 1 from public.user_recipe_preferences
                where user_id = 'b1020000-0000-4000-8000-000000000002' and recipe_id = 'usr-a1020000-0000-4000-8000-000000000001-pub'),
    'B preference survives creator restoration'
);

select pg_temp.assert(
    (select is_deleted is false from public.user_stats
     where user_id = 'b1020000-0000-4000-8000-000000000002' and stat_uuid = 'f02-b-builtin'),
    'B built-in stats remain active'
);

select pg_temp.assert(
    exists (select 1 from public.user_recipe_preferences
                where user_id = 'b1020000-0000-4000-8000-000000000002' and recipe_id = '101'),
    'B built-in preference remains'
);

-- The AFTER INSERT deletion path must also scope every side effect to A.

set local role authenticated;
set local request.jwt.claims = '{"sub":"a1020000-0000-4000-8000-000000000001","role":"authenticated"}';

insert into public.user_recipes
    (id, vendor_id, brewing_method_id, coffee_amount, water_amount, water_temp, brew_time, ispublic, is_deleted)
values ('usr-a1020000-0000-4000-8000-000000000001-gone', 'usr-a1020000-0000-4000-8000-000000000001', 'f02-test', 15, 250, 93, 180, false, true);

reset role;

select pg_temp.assert(
    (select is_deleted is true from public.user_stats
     where user_id = 'a1020000-0000-4000-8000-000000000001' and stat_uuid = 'f02-a-gone'),
    'Already-deleted insert soft-deletes A stats'
);

select pg_temp.assert(
    not exists (select 1 from public.user_recipe_preferences
                where user_id = 'a1020000-0000-4000-8000-000000000001' and recipe_id = 'usr-a1020000-0000-4000-8000-000000000001-gone'),
    'Already-deleted insert deletes A preference'
);

select pg_temp.assert(
    (select is_deleted is false from public.user_stats
     where user_id = 'b1020000-0000-4000-8000-000000000002' and stat_uuid = 'f02-b-gone'),
    'Already-deleted insert leaves B stats active'
);

select pg_temp.assert(
    exists (select 1 from public.user_recipe_preferences
                where user_id = 'b1020000-0000-4000-8000-000000000002' and recipe_id = 'usr-a1020000-0000-4000-8000-000000000001-gone'),
    'Already-deleted insert leaves B preference intact'
);

select pg_temp.assert(
    (select is_deleted is false from public.user_stats
     where user_id = 'b1020000-0000-4000-8000-000000000002' and stat_uuid = 'f02-b-builtin'),
    'B built-in stats remain active'
);

select pg_temp.assert(
    exists (select 1 from public.user_recipe_preferences
                where user_id = 'b1020000-0000-4000-8000-000000000002' and recipe_id = '101'),
    'B built-in preference remains'
);

-- Even postgres cannot insert a malformed owner namespace.

do $$
begin
    insert into public.user_recipes
        (id, vendor_id, brewing_method_id, coffee_amount, water_amount, water_temp, brew_time, ispublic, is_deleted)
    values ('usr-not-a-uuid-x', 'usr-not-a-uuid', 'f02-test', 15, 250, 93, 180, false, true);
    raise exception 'expected failure: invalid vendor UUID';
exception when check_violation then null;
end $$;

-- Check grants and function security configuration without relying on caller RLS.

select pg_temp.assert(
    not has_function_privilege('anon', 'public.handle_user_recipe_deletion()', 'execute'),
    'anon execute privilege is false'
);

select pg_temp.assert(
    not has_function_privilege('authenticated', 'public.handle_user_recipe_deletion()', 'execute'),
    'authenticated execute privilege is false'
);

select pg_temp.assert(
    has_function_privilege('service_role', 'public.handle_user_recipe_deletion()', 'execute'),
    'service_role execute privilege is true'
);

select pg_temp.assert(
    has_function_privilege('postgres', 'public.handle_user_recipe_deletion()', 'execute'),
    'postgres execute privilege is true'
);

select pg_temp.assert(
    (select prosecdef and proconfig @> array['search_path=""']
     from pg_catalog.pg_proc
     where oid = 'public.handle_user_recipe_deletion()'::regprocedure),
    'Trigger remains SECURITY DEFINER with empty search_path'
);

select pg_temp.assert(
    position('SET search_path TO ' || chr(39) || chr(39) in
             pg_get_functiondef('public.handle_user_recipe_deletion()'::regprocedure)) > 0,
    'Function definition declares empty search_path'
);

select pg_temp.assert(
    (select count(*) = 2 and bool_and(convalidated)
     from pg_catalog.pg_constraint
     where conrelid = 'public.user_recipes'::regclass
       and conname in ('user_recipes_vendor_id_user_namespace',
                       'user_recipes_id_in_vendor_namespace')),
    'Both namespace constraints exist and are validated'
);

rollback;
