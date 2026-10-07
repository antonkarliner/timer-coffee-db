# Roaster post-processing runbook

Operator guide for the durable roaster post-processing pipeline introduced by
plan 029. Covers monitoring, retry, reconciliation and rollback.

## What the pipeline is

Writes to `public.coffee_roasters` no longer do network calls or table scans
inside the user transaction. Triggers only **enqueue**; a worker does the work.

```
INSERT/UPDATE coffee_roasters
        |
        |  (triggers, in-transaction, index-backed, no network)
        v
service.roaster_postprocess_jobs          <-- durable source of truth
        ^
        |  pg_cron every minute -> public.roaster_postprocess_dispatch_cron()
        |  (advisory-locked, wakes the worker via pg_net ONLY if work is runnable)
        v
Edge Function roaster-postprocess-worker
        |  claims a bounded batch with FOR UPDATE SKIP LOCKED
        +-- mirror_logo    -> mirrors roaster_logo_url into storage
        +-- extract_color  -> dominant colour from the mirror
        +-- attach_beans   -> attaches unambiguous global_coffee_beans
```

`pg_net` is only a **wake-up mechanism**. If pg_net, Cron or the Edge Function
is unavailable, jobs stay in `queued` and the next tick retries. Nothing is
lost, because the ledger table — not `net._http_response` — is the record.

### Job kinds and their `source_revision`

`source_revision` identifies the *input* a job was created for. It must be
byte-identical everywhere or the dedupe index stops working.

| kind | source_revision |
|---|---|
| `mirror_logo` | `coffee_roasters.roaster_logo_url` |
| `extract_color` | `coffee_roasters.roaster_logo_mirror_url` |
| `attach_beans` | `coalesce(normalized_name,'') \|\| '\|' \|\| coalesce(normalized_aliases,'')` |

These are **raw values, never hashed**. A hashed revision will never match a
trigger-created job and silently double-queues every job.

### States

`queued` -> `running` -> `succeeded`, or -> `retry_wait` -> `running` -> ...,
or -> `failed` (terminal).

Backoff on retry is `30s * 2^min(attempts,6)` with 0.5–1.5x jitter, capped by
`max_attempts` (default 8).

## Monitoring

Health at a glance:

```sql
select kind, state, count(*), min(run_after), max(attempts)
from service.roaster_postprocess_jobs
group by kind, state
order by kind, state;
```

Alert on any of these:

```sql
-- 1. Terminal failures (need a human; they will never retry themselves)
select id, roaster_id, kind, error_class, last_error, finished_at
from service.roaster_postprocess_jobs
where state = 'failed'
order by finished_at desc;

-- 2. Retry backlog going stale (work that keeps failing transiently)
select count(*) as stale_retries
from service.roaster_postprocess_jobs
where state = 'retry_wait' and run_after < now() - interval '1 hour';

-- 3. Jobs stuck running (worker died mid-flight; the dispatcher recovers these,
--    so a persistent non-zero count means the dispatcher is not running)
select count(*) from service.roaster_postprocess_jobs
where state = 'running' and locked_at < now() - interval '10 minutes';

-- 4. Is the dispatcher alive at all?
select jobname, schedule, active from cron.job
where jobname = 'roaster-postprocess-dispatch';

select * from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'roaster-postprocess-dispatch')
order by start_time desc limit 10;
```

Every worker log line carries `job_id`, `roaster_id`, `kind`, `source_revision`,
`attempt` and `correlation_id`. Use `correlation_id` to follow one job across
the database and the Edge Function logs.

### Error classes

| error_class | Terminal? | Meaning / action |
|---|---|---|
| `source_too_large` | yes | Source decodes above the 16 Mpx cap. Message includes detected dimensions. Replace `roaster_logo_url` with a smaller asset. |
| `unsupported_format` | yes | AVIF/HEIC/HTML masquerading as an image. Fix the source URL. |
| `svg_rasterization_unsupported` | yes | SVG could not be rasterised for colour work. Do **not** treat as "no colour". |
| `stale_revision` | n/a (success) | A newer job supersedes this one. Expected and harmless. |
| (none, success, `dominant_color_hex` stays null) | n/a | The **fully-transparent rule**: the asset decoded fine but has zero opaque pixels, so there is no representative colour. Verified real case: roaster 1567 "Bruno Brown Cafe", whose source is a 2.45 MB animated GIF whose first frame is entirely transparent. Reconciliation deliberately stops reporting `mirror_without_color` once a **succeeded `extract_color` job exists for the current mirror revision** — otherwise it would flag such a roaster forever. Change the mirror and it becomes reportable again. |
| `http_5xx`, `http_429`, `http_408`, `network` | no | Transient; retries with backoff. |
| `storage_upload_failed` | no | Transient; retries. |

## Retry and manual intervention

```sql
-- Requeue one job by id (resets attempts, runs immediately)
select * from service.requeue_roaster_job(12345);

-- Requeue every terminal failure of one kind (use deliberately)
select service.requeue_roaster_job(id)
from service.roaster_postprocess_jobs
where state = 'failed' and kind = 'mirror_logo';

-- Recover jobs whose worker died, without waiting for the dispatcher
select service.recover_stale_roaster_jobs('10 minutes');

-- Force a job for an input that already succeeded (e.g. after fixing the worker)
select service.enqueue_roaster_job(
  <roaster_id>, 'mirror_logo', <the roaster's current roaster_logo_url>,
  now(), true   -- p_force
);
```

## Reconciliation

Reports every violated invariant; safe and read-only with `false`:

```sql
select violation, roaster_id, detail
from service.reconcile_roaster_postprocessing(false)
order by violation, roaster_id;
```

Violations reported: `missing_profile`, `source_without_mirror`,
`mirror_without_color`, `unattached_exact_bean`, `terminal_job`.

Passing `true` idempotently enqueues the fixable ones. It is safe to run
repeatedly — verified: two consecutive `reconcile(true)` runs produce identical
job counts, because `uniq_roaster_job_active` dedupes on
`(roaster_id, kind, source_revision)`.

```sql
select count(*) from service.reconcile_roaster_postprocessing(true);
```

`missing_profile` is deliberately **not** enqueued — no job kind creates
profiles; that stays `trg_create_roaster_profile`'s responsibility.
`terminal_job` is never enqueued — use `requeue_roaster_job`.

Run reconciliation after every roaster-review batch, and on a schedule in
production.

## Roaster-review batches

The review tooling no longer disables triggers. A run is complete only when the
verifier exits zero.

```bash
node scripts/roaster-review/verify-batch.mjs scripts/roaster-review/runs/<batch-id>.json
```

Exit `0` only when every expected job succeeded and batch-scoped reconciliation
is clean; exit `1` for unresolved entries, outstanding/failed/missing jobs, or
any invariant violation.

**Maintenance mode.** `ROASTER_REVIEW_MAINTENANCE=1` is the only way to bypass
the enqueue triggers, and it pairs the bypass with explicit
`service.enqueue_roaster_job(...)` calls inside the same transaction, so
equivalent durable jobs exist even though the triggers did not fire. Default
generation disables nothing.

## Rollback

The pipeline is additive: the ledger and worker can be paused without data loss.

1. **Pause the dispatcher** (jobs accumulate in `queued`; nothing is lost):
   ```sql
   select cron.unschedule('roaster-postprocess-dispatch');
   ```
2. **Pause the worker** as needed. The legacy `roaster-logo-mirror` and
   `generate-roaster-dominant-color` routes are retired (410); do not restore
   the HTTP triggers from `20260427000000` or re-point triggers at those routes.
   Rollback means pausing the dispatcher / worker instead.
3. **Keep queued jobs for replay.** Do not truncate
   `service.roaster_postprocess_jobs`. After correcting the fault, re-schedule
   the dispatcher and the backlog drains on its own.
4. Re-run reconciliation and confirm zero violations before declaring recovery.

## Gotchas

- **Local stack triggers pointed at production.** Before plan 029, the local
  database's `process_new/updated_coffee_roaster_logo` triggers were created by
  `supabase_functions.http_request(...)` with a **literal production URL**, so
  inserting a roaster locally POSTed to production and could overwrite a real
  roaster's mirror by id collision. The 029 enqueue triggers only write to a
  local table, which removes the hazard. The legacy HTTP routes are now retired;
  do not restore those triggers.
- **`edge_functions_api_key` is not provisioned in Vault.** The dispatcher
  therefore falls back to the legacy `Authorization: Bearer <service_role_key>`
  JWT, which the platform rejects ~1–2% of the time with
  `UNAUTHORIZED_LEGACY_JWT`. This is harmless here by design: a failed wake-up
  leaves jobs `queued` and the next tick retries. Provisioning the key removes
  the noise.
- **`supabase db push` applies every pending migration**, not just yours. Check
  `supabase migration list` before pushing when more than one workstream has
  uncommitted migrations.
- **You cannot un-attach a bean by setting `coffee_roaster_id = null`** while
  `trg_link_global_bean_to_coffee_roaster` is enabled — that BEFORE trigger
  immediately re-resolves it. Disable the trigger for the duration of any such
  maintenance.

## Measured baselines

Local stack (1,800 roasters / 12,059 beans), isolating the bean-attachment fix:

| | Before 029 | After 029 |
|---|---|---|
| 1 roaster insert | 12,009 ms | 1.0 ms |
| 50-roaster batch | > 600,000 ms (timed out) | 24.6 ms |
| Buffers touched by attachment | 10,637 | 2 |
| pg_net requests from write path | 2 per insert | 0 |

**Production** (1,847 roasters / 12,160 beans / 260 bean_reviews), measured on
2026-09-14 with self-cleaning probes:

| | Before 029 | After stage 3 | After the review-linking fix | Target |
|---|---|---|---|---|
| 1 roaster insert | 611 ms | 611 ms | **61 ms** | < 100 ms ✅ |
| 50-roaster batch | 27,983 ms | 27,983 ms | **2,082 ms** | < 2,000 ms ⚠️ |

Stage 3 alone did **not** move production, because the dominant cost was not
the bean attachment at all — it was `link_pending_bean_reviews` on
`roaster_profiles` evaluating `resolve_roaster_profile_for_review()` across
every unlinked review on every insert (533 ms of a 543 ms trigger cost).
`20260914160000_indexed_bean_review_linking.sql` fixed that.

### Known residual: invariant 4 is not fully satisfied

The rewritten `link_pending_bean_reviews` still builds its `owners` set with
**two sequential scans of all 1,847 `roaster_profiles`** (43 ms per insert —
exactly the 50 × 41.6 ms that leaves the batch 4% over target):

```
Seq Scan on roaster_profiles  (rows=1847)   18.4 ms   -- name half
Seq Scan on roaster_profiles  (rows=1847)   24.5 ms   -- alias half, lateral regexp_split
```

To close it:

1. **Name half** — an expression index gets this one for free:
   ```sql
   create index on public.roaster_profiles
     (lower(public.immutable_unaccent(trim(roaster_name)))) where is_active;
   ```
2. **Alias half** — cannot be indexed while aliases are a comma-separated string
   split with `regexp_split_to_table`. It needs the alias terms materialized
   into their own indexed table (e.g. `roaster_profile_terms(profile_id, term)`)
   maintained by a trigger on `roaster_profiles`. That is the same shape as the
   `normalized_roaster` column added for beans, and would also let
   `resolve_roaster_profile_for_review` and `resolve_coffee_roaster_id` become
   index lookups instead of scans.

Until (2) lands, every roaster insert still performs a table-wide scan inside
the user transaction, which plan 029's invariant 4 forbids. It is now ~13x
cheaper than before, but it is not gone.
