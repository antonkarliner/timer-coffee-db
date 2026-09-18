-- plan 034: also record the existing deterministic resolver's answer in each
-- Jev roaster-link eval row. deterministic_roaster_id stores the result of
-- public.resolve_coffee_roaster_id(raw_roaster) taken at decision time, so
-- shadow data can separate scans the existing matcher already handles from
-- scans it cannot. NULL means the existing matcher could not resolve the
-- string (or the lookup failed).
--
-- Logging only: no grants needed (a new column inherits the table's
-- privileges) and no backfill — rows are written going forward only.

alter table service.jev_eval_roaster_link
  add column if not exists deterministic_roaster_id bigint;
