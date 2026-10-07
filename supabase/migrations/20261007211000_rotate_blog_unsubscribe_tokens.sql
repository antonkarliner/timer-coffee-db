-- Security F11 follow-up: rotate every newsletter unsubscribe token.
--
-- Until 20261007210000, add_subscriber() handed any subscriber's token to
-- anyone holding the public anon key, so every existing token must be treated
-- as disclosed. This one-time operational rotation was previewed (15
-- subscribers, 13 confirmed) and approved on 2026-10-07. It is deliberately a
-- separate migration, not a side effect of the access-control fix.
--
-- Effect: unsubscribe links in emails sent before today stop working; every
-- later newsletter email carries the new token. Do not reverse this by
-- restoring old tokens. Replaying it on another database is harmless (it only
-- issues fresh random tokens).
update public.blog_subscribers
set token = gen_random_uuid();
