# Plan 041 §5 operator verification

Text only: this script was not executed. Apply migrations 20261003120000,
20261003120100, and 20261003120200 in order after reviewing them. No live push
was sent during implementation. Local-time delivery and the admin UI remain
separate tasks.

Run the read-only checks after applying the migration:

```sql
-- Every new/replaced function from 20261003120200, including its exact signature.
select n.nspname, p.proname,
       pg_get_function_identity_arguments(p.oid) as arguments,
       p.proacl::text, p.proconfig, p.prosecdef
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where (n.nspname = 'service' and p.proname in (
  'normalize_fcm_token_geo', 'get_broadcast_tokens',
  'lock_due_scheduled_notifications'
)) or (n.nspname = 'public' and p.proname = 'estimate_broadcast_reach')
order by 1, 2;
-- service function EXECUTE: postgres/service_role only.
-- estimate EXECUTE: postgres/authenticated/service_role; no PUBLIC/anon.
-- All functions must have explicit search_path; the token trigger is invoker.

select locale, count(*)
from service.user_fcm_tokens where is_active group by 1;
-- Check app plan 076 adoption before trusting language reach.

-- Execute with the signed-in admin JWT via RPC, or in an authorized service context.
select public.estimate_broadcast_reach(
  p_audience_filter => '{"locales":["de"],"regions":["EU"]}'::jsonb,
  p_platform => 'ios',
  p_target_user_ids => array['00000000-0000-0000-0000-000000000000'::uuid]
);
-- Replace the placeholder UUID with the operator's own UUID.
-- This is read-only. An authenticated non-admin must raise 42501.

select count(*) as seeded_countries from public.country_regions; -- 72
select region, array_agg(country_code order by country_code)
from public.country_regions group by region order by region;
```

`total_active` counts all active tokens. `total` and `by_locale` count matched
tokens after platform, user IDs, and audience restrictions. Null locales use
`unknown`. `unknown_country_excluded` applies the same non-geographic filters,
then counts tokens excluded for missing country or an unknown region when a
region restriction is present. Known geography that simply does not match is not
an unknown-country exclusion. `unknown_timezone` counts matched tokens with null
timezone.

After deployment, verify a filtered dry run includes `audience_filter` and
`matched_token_count`. Any actual push verification must use only the operator's
own `target_user_ids`, including both an audience that matches and one that
excludes their token. Check scheduled list/update persistence and the worker's
locked return column. Never omit that user restriction for a live push test.
