# Daily app-store ratings

The landing page can read `get-app-store-ratings` or select the aggregate-only
`public.app_store_ratings` table. This implementation does not modify the landing
page. Missing stores have no fabricated score or count.

## Collection

- `sync-app-store-ratings`: scans all 175 Apple storefronts, ten per invocation,
  with at least 3.5 seconds between lookup requests. A database lease prevents
  overlapping sweeps. Cron invokes it every five minutes between 02:00 and 04:55
  UTC; a completed daily run becomes a no-op. Normally a full sweep takes about
  90 minutes. Failed countries are retried in the remaining window. Only a full
  sweep publishes a snapshot; partial results remain private. Successful empty
  storefronts count as unavailable, not network errors. Country fallback
  responses are rejected to prevent double counting.
- Apple averages are weighted by each storefront's `userRatingCount`; the
  misleadingly named scraper `reviews` field and written review feeds are not
  used. The result is approximate because upstream average precision is finite.
- `sync-google-play-ratings`: runs at 04:45 UTC, obtains a Google OAuth token with
  the `devstorage.read_only` scope, paginates the bucket's rating objects, and
  downloads the newest overview CSV (previous month if the newest is empty).
  If listing is forbidden, it tries only the documented current/previous-month
  app report paths directly; missing files fall back to the previous month.
  UTF-16 and UTF-8 CSVs are supported. Report date and collection time are separate.
- The actual Play Console Overview export contains `Date`, `Package Name`,
  `Daily Average Rating`, and `Total Average Rating`, with no dimension or rating
  count. Its total average is the worldwide metric. The collector accepts that
  exact schema only from `_overview.csv` paths; a dimensionless file is never
  assumed global without that provenance. It prefers the latest two overview
  files before trying the latest two country files. Country averages cannot
  produce a weighted worldwide rating. For a country report the collector
  publishes only an explicit overall row. If none exists, it records
  country observations privately, marks the run `blocked` with
  `google_no_overall_rating`, and preserves any previous public snapshot. Blank
  and `Other` segments are never treated as global totals. This
  export's total/lifetime average also differs from Google's recency-weighted,
  country/device-specific public listing score.
- History of runs and country observations is retained for 90 days. The two
  current public snapshots survive collection or cleanup failures.

## Configuration

Reuse existing Edge Function secrets:

| Secret | Use |
| --- | --- |
| `GOOGLE_PLAY_SERVICE_ACCOUNT` | Complete service-account JSON; never log or return it |
| `GOOGLE_PLAY_PACKAGE_NAME` | `com.coffee.timer` |
| `GOOGLE_PLAY_REPORTS_BUCKET` | Bucket name, without `gs://` or path |
| `CRON_JOB_SECRET` | Existing system token for collectors |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Injected platform credentials |
| `ALLOWED_ORIGINS` | Existing shared CORS configuration; include the landing origin |
| `APP_STORE_APP_ID` | Optional; defaults to `6449322787` |

The Google service account needs Play Console's account-wide **View app
information and download bulk reports (read-only)** permission. Do not create
another JSON secret under a different name. The implementation does not grant
permissions or create credentials.

Cron dispatch reads existing Vault entries `supabase_url` and `cron_job_secret`.
The Vault cron token must match the Edge Function `CRON_JOB_SECRET`; these are
separate configuration stores. Do not expose decrypted Vault secrets in queries
or logs. The private dispatcher can only target the two collectors; only the
database owner can execute it. Collectors accept `X-System-Token` or the exact
service-role bearer and reject ordinary user JWTs. Gateway JWT verification is
disabled deliberately because custom auth runs before all collection work.

## Deploy and verify

Source creation does not deploy or apply anything. Use the Supabase CLI:

```sh
supabase migration list
supabase db push --dry-run
# Check that ONLY the intended ratings migration is pending before applying.
supabase functions deploy sync-app-store-ratings
supabase functions deploy sync-google-play-ratings
supabase functions deploy get-app-store-ratings
supabase db push
```

Deploy the functions before applying migrations: the bootstrap migration queues
one initial refresh through the same Vault/pg_net dispatcher used by cron. Check
the eventual responses in `net._http_response`. Deploy before the first scheduled
window. Do not repair migration
history or include unrelated pending migrations automatically.

Invoke the collectors server-side using the existing cron token (never put it in
the landing page). Google needs one call; Apple needs successive batches. Avoid
rapidly retrying an expired lease because upstream limits still apply. Check
`service.app_store_rating_runs` for `status`, `last_error_code`, and `updated_at`.
For cron transport, inspect `net._http_response` separately: `net.http_post`
queues requests and returning a request ID is not proof of successful collection.

Verify the real Google CSV headers against Play Console without exporting review
content or other private report data. A `blocked` country-only fallback is not
proof that authentication failed. The verified overview export supplies the
worldwide score without combining country means; unavailable counts remain null.

## Public response and caching

```json
{
  "ratings": [{
    "store": "app_store",
    "appId": "6449322787",
    "averageRating": 4.85,
    "ratingCount": 300,
    "scope": "worldwide",
    "sourceDate": "2026-09-30",
    "fetchedAt": "2026-09-30T03:25:00Z",
    "methodology": "weighted_storefront_averages",
    "isApproximate": true,
    "coverage": { "countriesRequested": 175, "countriesAvailable": 175, "countriesWithRatings": 40 }
  }],
  "missingStores": ["google_play"]
}
```

Values above are examples, not current metrics. `ratingCount` can be null for
Google and must be omitted from UI copy in that case. Keep the stores separate;
their rating definitions differ. Use one decimal place for display, the source
date for freshness, and a fallback hiding missing scores.

The GET endpoint reads only persisted aggregates, supports ETag / 304 and HEAD,
and sends `max-age=300, s-maxage=3600` with a one-day stale fallback. Empty or failed
responses are not cached. Deployment providers may require additional CDN cache
configuration; these headers do not guarantee an Edge-side cache hit. In the
Next.js Pages Router landing, fetch server-side in `getStaticProps` and retain
the existing ISR cache. No request to Apple or Google is on the rendering path.

## Checks and rollback

```sh
deno test --allow-env supabase/functions/_shared/store-ratings
deno test --allow-read --allow-env tests/store-ratings/migration_test.ts
deno check supabase/functions/sync-app-store-ratings/index.ts \
  supabase/functions/sync-google-play-ratings/index.ts \
  supabase/functions/get-app-store-ratings/index.ts
```

The SQL test uses disposable PGlite PostgreSQL and stubs only Vault/pg_net/cron;
it checks actual leases, RLS, weighted aggregation, and stale/partial publication
rules. It does not verify the production gateway, Vault values, remote report
access, or scheduling.

Rollback starts by unscheduling `sync-app-store-ratings-daily-batches` and
`sync-google-play-ratings-daily` as the database owner. Keep snapshots while the
landing still reads them. Remove the functions and data only after consumers are
removed; do not drop existing shared auth utilities or secrets.

Official contracts:
- [Apple storefront availability](https://support.apple.com/en-us/118205)
- [Apple lookup country and rate limits](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/Searching.html)
- [Google report format, access and lag](https://support.google.com/googleplay/android-developer/answer/6135870?hl=en)
- [Google rating definitions](https://support.google.com/googleplay/android-developer/answer/138230?hl=en)
- [Supabase scheduling and Vault](https://supabase.com/docs/guides/functions/schedule-functions)

## Production verification, 2026-09-30

The three functions and pipeline migration were deployed using the CLI. A full
Apple sweep collected all 175 storefronts (174 available, 59 with ratings) and
published an approximate weighted average of 4.913693114446529 from 533 ratings.
Unauthenticated collector calls returned 401; the public GET and HEAD returned
200 with the expected cache policy. A live gateway weakened the ETag during
compression, so conditional GET now uses weak comparison and handles tag lists
and the wildcard validator.

Google OAuth authentication succeeded, but bucket listing returned
`google_list_http_403_forbidden`. The configured bucket digest matches the URI
copied directly from Play Console. No Google snapshot was published. Verify that
the JSON's `client_email` matches the service account granted account-wide bulk
report access before retrying. The overview-report correction described below
supplies the worldwide metric once access succeeds.

The follow-up bootstrap migration exercised the actual Vault/pg_net cron path:
Apple returned 200/complete, and Google reached its authenticated collector but
returned 502 with the same upstream storage permission error. Both cron jobs are
active. Live conditional GET (weak ETag and a tag list) and conditional HEAD
(wildcard) returned 304 after the gateway fix; plain HEAD returned 200 with an
empty body, writes returned 405, and the landing origin's CORS header matched.
A repeat Apple collector invocation returned complete without collecting again.

A subsequent diagnostic test also tried the current month's country report
without listing the bucket. This returned `google_download_http_403`, confirming
that direct object access is denied too. Compare the JSON secret's `client_email`
with the exact Play Console user granted global bulk-report read access. The
service account whose permission was inspected in the console was
`version-check@timer-coffee-play-store.iam.gserviceaccount.com`; the deployed
secret's account identity was subsequently verified through the authenticated
email-only diagnostic and matches that account.

If the local service-account JSON is unavailable, an authenticated POST to
`sync-google-play-ratings?diagnostics=identity` returns only `serviceAccountEmail`.
The existing collector authorization runs first, the response is uncached, and
this action makes no database writes or Google requests. Keys and tokens are
never returned or logged. Production verification returned 401 without auth and
200 with only the expected service-account email using the service credential.

The matching Play Console user was reopened after the deployed identity check.
The account-level bulk-report read permission is saved and checked; the account
is active with indefinite access. A missing local JSON file and mismatched
service-account identity are therefore ruled out as causes of the remaining 403.

Authenticated POST `sync-google-play-ratings?diagnostics=access` probes listing,
object metadata, JSON media, and XML media for the current overview object. It
returns only status and allowlisted error codes, cancels successful bodies, makes
no database writes, and uses the same privileged gate and uncached response.
Production returned object-list and object-read denial codes, rather than an
anonymous caller or insufficient OAuth scopes. Google explicitly documents that
[developer-level permission changes can take up to 48 hours to propagate](https://developers.google.com/android-publisher/api-ref/rest/v3/users#developerlevelpermission).
The read permission was enabled September 30; propagation is the leading
explanation, not a confirmed resolution.

The owner successfully downloaded the September Overview CSV through Play
Console. Local inspection confirmed the exact four-column schema above and the
latest populated global total average **4.9411**, source date **2026-09-26**.
The collector now prefers this file and its real bytes passed the deployed parser
locally. The file has no rating count. No manual Google snapshot was inserted;
automated service-account access must still succeed before publication.

An hourly follow-up was configured in the current Codex chat, automation
`resolve-google-play-ratings-access`. It retests using existing credentials
without logging them and verifies persistence/public reads when collection works.
If the same access denial remains after October 2 at 16:00 UTC, it stops repeated
retries and prepares sanitized evidence for Google support. It does not send
support messages, create keys, or widen permissions.

## Additional access investigation, 2026-10-01

The Play Console user export confirms the deployed account has `ACCESS_GRANTED`,
no expiration, and `CAN_VIEW_NON_FINANCIAL_DATA_GLOBAL` (plus global quality
read). This independently verifies the saved permission instead of relying on
the UI checkbox alone. The service-account project's Enabled APIs dashboard
lists Cloud Storage API, Google Cloud Storage JSON API, and Android Publisher API.

The exact September object at
`gs://pubsite_prod_5112670129445645819/stats/ratings/ratings_com.coffee.timer_202609_overview.csv`
downloaded successfully through the signed-in owner's direct Cloud Storage URL.
It has the verified schema, source date 2026-09-26 and total average 4.9411.
Therefore the bucket name, September object path, and file existence are verified.
The documentation's `_rev_` example must not replace this actual bucket name.

To isolate month-boundary failures, authenticated POST
`sync-google-play-ratings?diagnostics=access&period=previous` probes the previous
month's Overview object; only `current` and `previous` are accepted. An anonymous
request returns 401. The previous-month probe returned object-read denial through
metadata, JSON media and XML media, while listing also remained denied. October
report availability is therefore not the explanation for this existing-object
failure. All successful bodies are discarded and no credential is exposed.

Two matching public library reports have follow-up resolutions:
- [Python report](https://github.com/googleapis/google-cloud-python/issues/17521#issuecomment-4799433911):
  the reporter says the permission became effective after 24 hours.
- [Node report](https://github.com/googleapis/nodejs-storage/issues/2688#issuecomment-3683141871):
  a contributor resolved access using explicit service-account credentials and
  `devstorage.read_only`. Our collector already uses that exact scope and key.

These are firsthand reports, not proof of a confirmed Google platform incident.
The remaining leading explanation is propagation or a failed Play-to-Storage
permission synchronization. The current evidence does not justify extra project
IAM roles, financial permissions, an API key, or a new service-account key.
If the 48-hour window expires, ask Google Play support to check report-bucket
authorization synchronization for this exact principal and known-existing object.

## Access restored and verified, 2026-10-02

The authorized collector succeeded at 09:12 UTC without additional credentials,
permissions, or code changes. It persisted the worldwide Overview total average
**4.9444**, source date **2026-09-29**, with `rating_count = null`. Coverage records
`overallRow: true`, `reportType: overview`, and `countriesReported: 0`; this is the
global report value, not an average of country ratings. The result is consistent
with delayed permission propagation, though Google's internal cause is unconfirmed.

Independent database inspection and the public `get-app-store-ratings` endpoint
both returned this snapshot. The public endpoint returned HTTP 200, both stores,
no missing stores, an ETag, and the configured cache policy. Google does not supply
a count in this report, so clients must omit its count. This metric is Google's
total average and can differ from the score displayed on a particular storefront.

The hourly access-resolution automation was deleted after verification. Both
existing database schedules remain active, including Google collection at 04:45
UTC daily. No manual snapshot insertion or Google support request was needed.
