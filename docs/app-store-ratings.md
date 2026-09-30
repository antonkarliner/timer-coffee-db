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
  downloads the newest country CSV (previous month if the newest is empty).
  UTF-16 and UTF-8 CSVs are supported. Report date and collection time are separate.
- Google's documented export contains `Total Average Rating` but no rating
  counts. Country averages cannot produce a weighted worldwide rating. The
  collector publishes only an explicit overall row. If none exists, it records
  country observations privately, marks the run `blocked` with
  `google_no_overall_rating`, and preserves any previous public snapshot. Blank
  and `Other` segments are never treated as global totals. An actual authenticated
  report must be inspected before promising a worldwide Google score. This
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
supabase db push
supabase functions deploy sync-app-store-ratings
supabase functions deploy sync-google-play-ratings
supabase functions deploy get-app-store-ratings
```

Deploy the functions before the first scheduled window. Do not repair migration
history or include unrelated pending migrations automatically.

Invoke the collectors server-side using the existing cron token (never put it in
the landing page). Google needs one call; Apple needs successive batches. Avoid
rapidly retrying an expired lease because upstream limits still apply. Check
`service.app_store_rating_runs` for `status`, `last_error_code`, and `updated_at`.
For cron transport, inspect `net._http_response` separately: `net.http_post`
queues requests and returning a request ID is not proof of successful collection.

Verify the real Google CSV headers and overall-row semantics against Play Console,
without exporting review content or other private report data. A `blocked`
country-only result is expected with the documented format and is not proof that
authentication failed. A global Google score requires an additional trustworthy
overall metric source if those reports have no overall row.

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
