# EXECUTE policy for `public` SECURITY DEFINER functions

Decision record for plan 031 and the 2026-10-07 security-advisor findings
(`anon_security_definer_function_executable` ×61,
`authenticated_security_definer_function_executable` ×69). Measured against
production `mprokbemdullwezwwscn` on 2026-10-07: 69 SECURITY DEFINER functions
in `public` executable by `anon` or `authenticated` (61 by anon, 67 by
authenticated). After these migrations, measured on a production-schema replay:
18 by anon (all public by design, below), 37 by authenticated.

Implemented by migrations `20261007230000`–`20261007230400`; enforced by
`tests/security/f17_secdef_function_grants.sql` (privilege matrix plus an
allowlist drift guard) and `tests/security/f18_yearly_user_id_from_auth.sql`.

## How callers were established

- **App**: `rpc('<name>'` in `timer-coffee/lib` at the 3.9.0 release commit
  (`8d8e0e62`), 3.9.1 (`5d8fdf32`), 3.10.0 (`12686f9f`) and `HEAD`. Earlier
  versions are out of support. The app signs in anonymously at startup
  (`lib/main.dart`), so its calls arrive as `authenticated`. Production edge
  logs for 2026-10-06/07 agree: 619 of 620 `log_connection_endpoint` calls
  carried an `authenticated` JWT.
- **Website** (`timer-coffee-landing-2`): public roaster pages use the anon key
  (`src/lib/supabase/public-client.ts`); `/api/confirm` and `/api/unsubscribe`
  use the anon key; admin and roaster-portal routes use the signed-in user's
  session (`authenticated`).
- **Edge functions**: every caller (`manage-recipe-draft-lab-access`,
  `roaster-admin-onboarding`, `notification-api`, `normalize-bean-origins`,
  `submit-roaster-contribution`) uses the service-role key, for which
  `public.is_admin()` returns true.
- **SQL**: `cron.job` (all jobs run as `postgres`), `pg_trigger`, RLS policy
  quals resolved through `pg_depend` (not policy text), and nested calls
  between functions.

Anonymous sign-in is enabled, so anyone can get an `authenticated` JWT. Moving a
function from `anon` to `authenticated` is therefore hygiene, not a security
boundary. The boundaries that matter are (a) no ordinary role on cron, service
and admin-without-check paths, and (b) per-user functions deriving the user
from `auth.uid()`.

## Audiences

### Service-only — `{postgres, service_role}`

| Function | Why |
|---|---|
| 10 cron entrypoints: `aggregate_notification_analytics_cron`, `check_new_version_cron`, `cron_refresh_global_stats_daily`, `cron_refresh_global_stats_hourly`, `normalize_bean_origins_cron`, `process_app_release_notifications_cron`, `process_live_activity_events_cron`, `process_scheduled_notifications_cron`, `roaster_enrichment_worker_cron`, `token_cleanup_cron` | Run by pg_cron as `postgres`. They read Vault secrets and fire paid edge functions through pg_net, with no caller check, so anon could loop them into spend. |
| 11 trigger functions: `aggregate_coffee_volume`, `attach_pending_global_beans`, `check_new_roaster_webhook`, `create_roaster_profile_on_insert`, `enqueue_roaster_dominant_color_generation`, `enqueue_roaster_logo_mirror`, `invalidate_bean_review_translations`, `link_bean_review_to_roaster_profile`, `link_global_bean_to_coffee_roaster`, `link_pending_bean_reviews`, `sync_roaster_profile_on_update` | `returns trigger`: not callable directly, and firing never checks EXECUTE (plan 032). Hygiene only. |
| `get_unnormalized_bean_origins(integer)` | Only `normalize-bean-origins` (service role) calls it. |
| `refresh_yearly_user_liters(integer)` | Heavy upsert over every user's brews; no client caller. Operator-only. |
| `get_user_recipe_import_counts(text[])` | No caller anywhere. |
| `global_stats_daily_range_sum(date,date)` | App stopped calling it in `db02dc8f` (2026-08-13, before 3.9.0). |
| `global_stats_range_count(date,date)` | No caller anywhere. |
| `global_stats_hourly_range_summary(timestamptz,timestamptz)` | Only called inside `global_stats_live_summary`, a SECURITY DEFINER function owned by `postgres`, so the nested call is checked against `postgres`. |
| `get_roaster_profile_by_name(text)`, `search_roaster_unaccent(text)` | App stopped calling them in `6f3ac94a` (2026-07-06, before 3.9.0). |

### Admin — `{postgres, authenticated, service_role}`, body checks `public.is_admin()`

`admin_connection_analytics`, `admin_list_notifications`,
`admin_lookup_assignable_user_by_email`, `admin_notification_analytics`,
`admin_notification_health_metrics`, `admin_search_roaster_profiles`,
`admin_set_roaster_profile_owner`, `estimate_broadcast_reach`.

Each one raises `forbidden` (or returns null/no rows) unless `is_admin()`. The
website's admin pages call them with the admin's session, so `authenticated`
stays. Edge functions call them with the service-role key. The remaining
`authenticated` advisor findings for these eight are accepted: the guard lives
in the body. Removing `authenticated` would mean moving the website admin routes
to the service-role key.

### Signed-in — `{postgres, authenticated, service_role}`

| Function | Why |
|---|---|
| `get_my_roaster_profile()`, `update_my_roaster_profile(…)` | Roaster portal, admin session; both key on `auth.uid()`. |
| `log_recipe_import(text)` | Raises without `auth.uid()`. |
| `log_connection_endpoint(text,text)` | App telemetry sent after the startup anonymous sign-in. About one anon call a day would now fail; the app retries on the next launch. |
| `increment_likes()` | 2024 recap screen; app is signed in. |
| `roaster_contribution_target(text)` | App (signed in) and `submit-roaster-contribution` (service role). |
| `can_access_user_recipe(text,text)` | Qual of three `TO authenticated` RLS policies (`user_recipes`, `user_steps`, `user_recipe_localizations`). `authenticated` must keep it. Anon is never judged by those policies. |
| `pick_yearly_wish(uuid,text)` | **Body fixed**: the user now comes from `auth.uid()`. A non-null `p_user_id` that differs raises `42501`. Previously any caller could write a delivery row for any user id. |
| `yearly_user_liters_percentile(integer,uuid,double precision)` | **Body fixed**: the own row comes from `auth.uid()`. A `p_user_id` that is not the caller returns no rows. Previously it returned any user's liters when `p_liters` was null. |
| ~~`yearly_user_liters_percentile(integer,uuid)`~~ | **Dropped.** Every 2-argument call, positional, named or PostgREST, failed with `function … is not unique`, because the 3-arg overload's `p_liters` default also matched. It was unreachable. Dropping it lets the app's no-liters call resolve to the 3-arg function. |

Already authenticated-only before this work, unchanged:
`can_read_bean_review_translation(uuid)` (RLS qual), `get_brew_peers`,
`get_my_contribution_acknowledgements`, `mark_contribution_acknowledged` (the
last two key on `auth.uid()`).

### Public by design — `anon` keeps EXECUTE (accepted advisor findings)

| Function | Why |
|---|---|
| `confirm_subscription(uuid)`, `unsubscribe_subscriber(uuid)` | Newsletter capability tokens; the website calls them with the anon key. `{postgres, anon, service_role}`. |
| `is_admin()` | Qual of ~20 `TO public` policies on `service` tables. Revoking from either role turns client reads into `42501` (plan 033). Reveals only the caller's own status. |
| `get_launch_popup` | App launch content; may run before sign-in completes. |
| `list_roaster_profiles`, `get_roaster_countries`, `get_roaster_profile`, `get_roaster_rating_summary`, `get_roaster_recipes`, `get_roaster_review_facets`, `get_roaster_reviews`, `get_roaster_reviews_by_slug` | Public roaster directory; the website's server renders it with the anon key. |
| `get_roaster_bundle_by_name`, `get_roaster_profile_by_vendor_id` | Public profile data; app only. Restricting them would buy nothing (anyone can get an anonymous session) and would break users whose sign-in timed out. |
| `global_stats_daily_range_count`, `global_stats_live_summary`, `global_stats_range_sum`, `global_stats_top_recipes` | Aggregate community stats (Pulse screen, recaps); same reasoning. |

## Adding a function

New functions inherit `anon`/`authenticated` EXECUTE from default privileges.
Pick an audience above, revoke by name per role (see `CLAUDE.md`), and add the
function to the matching allowlist in `tests/security/f17_secdef_function_grants.sql`.
Otherwise its drift guard fails.
