\set ON_ERROR_STOP on
-- F01 follow-up: the anonymous-account RPC moves bean reviews (account's review
-- wins a duplicate), replies and notifications, resumes a data_migrated claim,
-- and leaves the guest Auth user deletable.
begin;

create function pg_temp.assert(ok boolean, msg text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Assertion failed: %', msg; end if;
end
$$;

-- G guest, A account, O other account, R roaster admin who replies,
-- G2 guest with a completed claim, G3 guest stuck at data_migrated by the old RPC.
insert into auth.users (id, instance_id, aud, role, email, is_anonymous,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select id::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  email, anon, '{}'::jsonb, '{}'::jsonb, now(), now()
from (values
  ('55555555-5555-4555-8555-555555555555', 'f01r-guest@example.invalid', true),
  ('66666666-6666-4666-8666-666666666666', 'f01r-account@example.invalid', false),
  ('77777777-7777-4777-8777-777777777777', 'f01r-other@example.invalid', false),
  ('88888888-8888-4888-8888-888888888888', 'f01r-roaster@example.invalid', false),
  ('99999999-9999-4999-8999-999999999999', 'f01r-guest-completed@example.invalid', true),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'f01r-guest-stuck@example.invalid', true)
) u(id, email, anon);

insert into public.bean_reviews (id, user_id, roaster_name, bean_name, coffee_beans_uuid, rating, review_text)
values
  -- g1: unique; has a translation and a roaster reply. Moves.
  ('b0000000-0000-4000-8000-000000000001', '55555555-5555-4555-8555-555555555555', 'Alpha', 'One', 'bean-g1', 4, 'guest one'),
  -- g2: same (roaster_name, bean_name) as a2. Dropped with its translation and reply.
  ('b0000000-0000-4000-8000-000000000002', '55555555-5555-4555-8555-555555555555', 'Alpha', 'Two', 'bean-g2', 3, 'guest two'),
  -- g3: same coffee_beans_uuid as a3, different names. Dropped.
  ('b0000000-0000-4000-8000-000000000003', '55555555-5555-4555-8555-555555555555', 'Beta', 'Three', 'bean-shared', 2, 'guest three'),
  -- g4: NULL coffee_beans_uuid, as is a5's; NULLs never collide. Moves.
  ('b0000000-0000-4000-8000-000000000004', '55555555-5555-4555-8555-555555555555', 'Beta', 'Four', null, 5, 'guest four'),
  ('b0000000-0000-4000-8000-0000000000a2', '66666666-6666-4666-8666-666666666666', 'Alpha', 'Two', 'bean-a2', 5, 'account two'),
  ('b0000000-0000-4000-8000-0000000000a3', '66666666-6666-4666-8666-666666666666', 'Gamma', 'Other', 'bean-shared', 1, 'account three'),
  ('b0000000-0000-4000-8000-0000000000a5', '66666666-6666-4666-8666-666666666666', 'Delta', 'Five', null, 3, 'account five'),
  ('b0000000-0000-4000-8000-0000000000f1', '77777777-7777-4777-8777-777777777777', 'Omega', 'Other', 'bean-o1', 4, 'other one'),
  ('b0000000-0000-4000-8000-0000000000c1', '99999999-9999-4999-8999-999999999999', 'Kappa', 'Done', 'bean-c1', 4, 'completed guest'),
  ('b0000000-0000-4000-8000-0000000000d1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Lambda', 'Stuck', 'bean-d1', 4, 'stuck guest');

insert into public.bean_review_translations (review_id, target_locale, source_locale, translated_text, model)
values
  ('b0000000-0000-4000-8000-000000000001', 'de', 'en', 'Gast eins', 'f01-test'),
  ('b0000000-0000-4000-8000-000000000002', 'de', 'en', 'Gast zwei', 'f01-test'),
  ('b0000000-0000-4000-8000-000000000003', 'de', 'en', 'Gast drei', 'f01-test');
insert into public.review_replies (id, review_id, user_id, reply_text)
values
  ('c0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', '88888888-8888-4888-8888-888888888888', 'thanks for one'),
  ('c0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', '88888888-8888-4888-8888-888888888888', 'thanks for two'),
  -- A reply authored by the guest (review_replies.user_id is NO ACTION too).
  ('c0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-0000000000f1', '55555555-5555-4555-8555-555555555555', 'guest reply');
insert into service.notifications (id, user_id, title, body)
  values ('d0000000-0000-4000-8000-000000000001', '55555555-5555-4555-8555-555555555555', 'F01', 'synthetic');

-- G2: claim already completed while the guest still (artificially) owns a review.
insert into service.anonymous_account_migrations (source_user_id, destination_user_id, status, moved, completed_at)
  values ('99999999-9999-4999-8999-999999999999', '66666666-6666-4666-8666-666666666666', 'completed', '{"global_stats":7}'::jsonb, now());
-- G3: the production failure shape. The old RPC wrote six keys and returned early on retry.
insert into service.anonymous_account_migrations (source_user_id, destination_user_id, status, moved)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '66666666-6666-4666-8666-666666666666', 'data_migrated',
    '{"global_stats":2,"label_invocations":0,"recipes":1,"recipe_localizations":1,"recipe_steps":3,"fcm_tokens":1}'::jsonb);

-- Before the fix this is what deleteUser hit: 23503 on bean_reviews_user_id_fkey.
do $$ begin
  delete from auth.users where id = '55555555-5555-4555-8555-555555555555';
  raise exception 'expected failure: guest with reviews is not deletable before the move';
exception when foreign_key_violation then null;
end $$;

set local role service_role;
do $$
declare
  result jsonb;
  resumed jsonb;
  first_moved jsonb := '{"global_stats":0,"label_invocations":0,"recipes":0,"recipe_localizations":0,"recipe_steps":0,"fcm_tokens":0,"bean_reviews":2,"bean_reviews_dropped_duplicates":2,"review_replies":1,"notifications":1}'::jsonb;
  merged_moved jsonb := '{"global_stats":0,"label_invocations":0,"recipes":0,"recipe_localizations":0,"recipe_steps":0,"fcm_tokens":0,"bean_reviews":3,"bean_reviews_dropped_duplicates":3,"review_replies":1,"notifications":1}'::jsonb;
begin
  -- (a) + (b): first run.
  result := service.migrate_anonymous_account_data('55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666');
  perform pg_temp.assert(result = jsonb_build_object('status', 'data_migrated', 'already', false, 'moved', first_moved), format('first run result, got %s', result));
  perform pg_temp.assert((select count(*) = 0 from public.bean_reviews where user_id = '55555555-5555-4555-8555-555555555555'), '(a) guest owns no reviews');
  perform pg_temp.assert((select user_id = '66666666-6666-4666-8666-666666666666' and review_text = 'guest one' from public.bean_reviews where id = 'b0000000-0000-4000-8000-000000000001'), '(a) g1 moved with id and text intact');
  perform pg_temp.assert((select user_id = '66666666-6666-4666-8666-666666666666' from public.bean_reviews where id = 'b0000000-0000-4000-8000-000000000004'), '(b) NULL-uuid g4 moved, NULLs do not collide');
  perform pg_temp.assert((select translated_text = 'Gast eins' from public.bean_review_translations where review_id = 'b0000000-0000-4000-8000-000000000001' and target_locale = 'de'), '(a) g1 translation still attached');
  perform pg_temp.assert((select user_id = '88888888-8888-4888-8888-888888888888' and reply_text = 'thanks for one' from public.review_replies where review_id = 'b0000000-0000-4000-8000-000000000001'), '(a) g1 roaster reply still attached, author unchanged');
  perform pg_temp.assert((select count(*) = 0 from public.bean_reviews where id in ('b0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000003')), '(b) name-duplicate and uuid-duplicate guest reviews dropped');
  perform pg_temp.assert((select count(*) = 0 from public.bean_review_translations where review_id in ('b0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000003')), '(b) dropped reviews'' translations cascaded');
  perform pg_temp.assert((select count(*) = 0 from public.review_replies where id = 'c0000000-0000-4000-8000-000000000002'), '(b) dropped review''s reply cascaded');
  perform pg_temp.assert((select count(*) = 3 from public.bean_reviews
      where user_id = '66666666-6666-4666-8666-666666666666'
        and (id, review_text, rating) in (
          ('b0000000-0000-4000-8000-0000000000a2', 'account two', 5),
          ('b0000000-0000-4000-8000-0000000000a3', 'account three', 1),
          ('b0000000-0000-4000-8000-0000000000a5', 'account five', 3))), '(b) account reviews untouched');
  perform pg_temp.assert((select count(*) = 5 from public.bean_reviews where user_id = '66666666-6666-4666-8666-666666666666'), '(b) account has its 3 plus 2 moved');
  perform pg_temp.assert((select user_id = '66666666-6666-4666-8666-666666666666' from public.review_replies where id = 'c0000000-0000-4000-8000-000000000003'), 'guest-authored reply moved');
  perform pg_temp.assert((select user_id = '66666666-6666-4666-8666-666666666666' from service.notifications where id = 'd0000000-0000-4000-8000-000000000001'), 'guest notification moved');
  perform pg_temp.assert((select status = 'data_migrated' and moved = first_moved from service.anonymous_account_migrations where source_user_id = '55555555-5555-4555-8555-555555555555'), 'ledger stores first counts');

  -- Rows written to the guest after the first move (deleteUser failed, or a late sync).
  insert into public.bean_reviews (id, user_id, roaster_name, bean_name, coffee_beans_uuid, rating)
  values
    ('b0000000-0000-4000-8000-000000000005', '55555555-5555-4555-8555-555555555555', 'Epsilon', 'Six', 'bean-g5', 4),
    -- Duplicates g1, which the account now owns.
    ('b0000000-0000-4000-8000-000000000006', '55555555-5555-4555-8555-555555555555', 'Alpha', 'One', 'bean-g6', 2);

  -- (e) a different destination is refused and moves nothing.
  begin
    perform service.migrate_anonymous_account_data('55555555-5555-4555-8555-555555555555', '77777777-7777-4777-8777-777777777777');
    raise exception 'expected failure: different destination';
  exception when sqlstate 'PT409' then null;
  end;
  perform pg_temp.assert((select count(*) = 2 from public.bean_reviews where user_id = '55555555-5555-4555-8555-555555555555'), '(e) conflict moved nothing');
  perform pg_temp.assert((select destination_user_id = '66666666-6666-4666-8666-666666666666' and moved = first_moved from service.anonymous_account_migrations where source_user_id = '55555555-5555-4555-8555-555555555555'), '(e) claim unchanged');

  -- (c) resume: re-runs the moves and merges the counts.
  resumed := service.migrate_anonymous_account_data('55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666');
  perform pg_temp.assert(resumed = jsonb_build_object('status', 'data_migrated', 'already', true, 'moved', merged_moved), format('(c) resume result, got %s', resumed));
  perform pg_temp.assert((select user_id = '66666666-6666-4666-8666-666666666666' from public.bean_reviews where id = 'b0000000-0000-4000-8000-000000000005'), '(c) late review moved');
  perform pg_temp.assert((select count(*) = 0 from public.bean_reviews where id = 'b0000000-0000-4000-8000-000000000006'), '(c) late duplicate dropped');
  perform pg_temp.assert((select count(*) = 0 from public.bean_reviews where user_id = '55555555-5555-4555-8555-555555555555'), '(c) guest owns no reviews');
  perform pg_temp.assert((select status = 'data_migrated' and moved = merged_moved from service.anonymous_account_migrations where source_user_id = '55555555-5555-4555-8555-555555555555'), '(c) ledger stores merged counts');

  -- (c) the stuck production shape: an old six-key row recovers and gains the new keys.
  resumed := service.migrate_anonymous_account_data('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '66666666-6666-4666-8666-666666666666');
  perform pg_temp.assert(resumed = jsonb_build_object('status', 'data_migrated', 'already', true, 'moved',
      '{"global_stats":2,"label_invocations":0,"recipes":1,"recipe_localizations":1,"recipe_steps":3,"fcm_tokens":1,"bean_reviews":1,"bean_reviews_dropped_duplicates":0,"review_replies":0,"notifications":0}'::jsonb),
    format('(c) legacy row resume, got %s', resumed));
  perform pg_temp.assert((select user_id = '66666666-6666-4666-8666-666666666666' from public.bean_reviews where id = 'b0000000-0000-4000-8000-0000000000d1'), '(c) stuck guest review moved');

  -- (d) a completed claim returns early and moves nothing.
  result := service.migrate_anonymous_account_data('99999999-9999-4999-8999-999999999999', '66666666-6666-4666-8666-666666666666');
  perform pg_temp.assert(result = '{"status":"completed","already":true,"moved":{"global_stats":7}}'::jsonb, format('(d) completed early return, got %s', result));
  perform pg_temp.assert((select user_id = '99999999-9999-4999-8999-999999999999' from public.bean_reviews where id = 'b0000000-0000-4000-8000-0000000000c1'), '(d) nothing moved for a completed claim');
end
$$;

-- (a) the guest Auth user is now deletable (what auth.admin.deleteUser does).
reset role;
delete from auth.users where id in ('55555555-5555-4555-8555-555555555555', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
select pg_temp.assert((select count(*) = 0 from auth.users where id in ('55555555-5555-4555-8555-555555555555', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')), '(a) guests deleted');
select pg_temp.assert((select count(*) = 7 from public.bean_reviews where user_id = '66666666-6666-4666-8666-666666666666'), '(a) moved reviews survive guest deletion');

set local role service_role;
select pg_temp.assert(service.complete_anonymous_account_migration('55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666'), 'completion after deletion');
select pg_temp.assert(service.migrate_anonymous_account_data('55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666')
  = jsonb_build_object('status', 'completed', 'already', true, 'moved',
    '{"global_stats":0,"label_invocations":0,"recipes":0,"recipe_localizations":0,"recipe_steps":0,"fcm_tokens":0,"bean_reviews":3,"bean_reviews_dropped_duplicates":3,"review_replies":1,"notifications":1}'::jsonb),
  '(d) completed retry returns stored counts');

reset role;
select pg_temp.assert((select prosecdef = false and proconfig = array['search_path=""']
  from pg_catalog.pg_proc where oid = 'service.migrate_anonymous_account_data(uuid,uuid)'::regprocedure), 'RPC stays security invoker with empty search_path');
select pg_temp.assert(not has_function_privilege('anon', 'service.migrate_anonymous_account_data(uuid,uuid)', 'execute'), 'anon cannot migrate');
select pg_temp.assert(not has_function_privilege('authenticated', 'service.migrate_anonymous_account_data(uuid,uuid)', 'execute'), 'authenticated cannot migrate');
select pg_temp.assert(has_function_privilege('service_role', 'service.migrate_anonymous_account_data(uuid,uuid)', 'execute'), 'service_role can migrate');
select pg_temp.assert(not exists (
  select 1 from pg_catalog.aclexplode((select proacl from pg_catalog.pg_proc where oid = 'service.migrate_anonymous_account_data(uuid,uuid)'::regprocedure))
  where grantee = 0), 'PUBLIC has no EXECUTE');

select 'f01_bean_reviews_migration: all assertions passed' as result;
rollback;
