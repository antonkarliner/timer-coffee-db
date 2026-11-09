-- Plan 038 section 6.1: stop publishing every brewer's user_id.
--
-- Rows in public.global_stats stay publicly readable; only the user_id column
-- is withdrawn from client roles. Revoking table-level SELECT also removes the
-- existing column-level SELECT grants, so the readable columns are re-granted
-- explicitly, including country_code.
--
-- INSERT, UPDATE and DELETE grants are deliberately untouched: the app inserts
-- into this table as authenticated, and PostgREST's RETURNING constant reads no
-- columns.
--
-- Client impact: builds older than 3.9.0 read user_id or select * and will show
-- Pulse's network error and lose the in-sync moment until they update.
-- Operator confirmed the 90% adoption threshold on 2026-11-09 (99.0% measured).

revoke select on table public.global_stats from anon, authenticated;

grant select (id, brewing_method, recipe_id, water_amount, created_at, country_code)
  on table public.global_stats to anon, authenticated;
