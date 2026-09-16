-- Plan 035 §3: drop the aggregate-performance-metrics job and its function
--
-- `service.aggregate_performance_metrics()` ends with
--
--     ON CONFLICT (timestamp, service, endpoint, method) DO UPDATE SET ...
--
-- and `service.performance_metrics` has no unique index on those four columns, so
-- the statement is rejected at plan time on every run:
--
--     ERROR: there is no unique or exclusion constraint matching the ON CONFLICT specification
--
-- 182 consecutive failed runs on production as of 2026-09-16 — the full retained
-- history of cron.job_run_details.
--
-- Adding the missing unique index would be two lines, and it is the wrong fix.
-- The aggregate's source is `service.system_logs` filtered to
-- `endpoint is not null and duration_ms is not null`, and that filter has never
-- matched anything. Measured on production 2026-09-16, across the entire table:
--
--     service.system_logs total rows                     731,533
--     ...ever with endpoint not null                          58
--     ...ever with duration_ms not null                       52
--     ...ever with BOTH                                        0
--
-- Zero, over the whole history — not merely zero in the last hour. The two columns
-- are vestigial: something wrote one or the other a few dozen times and never wrote
-- them together. So the index would convert a loud hourly failure into a permanently
-- silent hourly no-op, which is strictly worse for observability.
--
-- There is also no consumer. `service.check_alert_thresholds()` was the suspected
-- reader; it in fact computes error_rate, avg_response_time and memory_usage from
-- `service.system_logs` directly and never references `performance_metrics` at all.
--
-- No source, no consumer, never once succeeded: drop the job and the function.
--
-- `service.performance_metrics` (the table) is deliberately KEPT. It is empty and
-- harmless, and `service.cleanup_old_logs()` still references it in its retention
-- sweep — dropping the table here would break that function. If the table is ever
-- to go, `cleanup_old_logs` has to be edited in the same change.

do $$
begin
    if exists (select 1 from cron.job where jobname = 'aggregate-performance-metrics') then
        perform cron.unschedule('aggregate-performance-metrics');
    end if;
end $$;

drop function if exists service.aggregate_performance_metrics();
