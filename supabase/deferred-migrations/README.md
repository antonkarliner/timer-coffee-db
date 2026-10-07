# Retire public newsletter token issuance

Apply `retire_public_blog_subscriber_issuance.sql` only after the website release
that proxies `/api/subscribe` to the `subscribe-blog` edge function is live.
The first migration intentionally leaves `add_subscriber` callable by anon and
accepts legacy confirmation links until this cutover. The token oracle remains
available during that transition, so complete the cutover promptly.

Copy this SQL file into `supabase/migrations/` with a `YYYYMMDDHHMMSS_` timestamp
later than the newest applied migration at that moment, then have the operator
run `db push`. Do not apply this deferred file with the first migration.
Afterward, old confirmation emails using the unsubscribe token no longer confirm
subscriptions; existing unsubscribe links continue to work.

The operator also adds `[functions.subscribe-blog]` with `verify_jwt = true` to
`supabase/config.toml` before deploying the function.

Test the deferred change in a transaction by piping `begin;`, the deferred SQL,
`tests/security/f11_blog_subscribers_deferred.sql`, and `rollback;` to psql:

```sh
{ echo 'begin;'; cat supabase/deferred-migrations/retire_public_blog_subscriber_issuance.sql; cat tests/security/f11_blog_subscribers_deferred.sql; echo 'rollback;'; } | psql
```

Run psql inside the local database container; do not use `\i` paths.
