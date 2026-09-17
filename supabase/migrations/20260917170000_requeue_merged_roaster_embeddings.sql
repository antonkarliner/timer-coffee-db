-- Requeue name_embedding for the 7 roasters whose aliases changed in
-- 20260917150000 (plan 036 section 7).
--
-- name_embedding covers roaster_name + aliases, so folding a merged roaster's
-- name into the survivor's alias list makes the stored vector stale.
--
-- public.add_roaster_alias nulls name_embedding when it appends an alias, but
-- 20260917150000 wrote aliases directly and deliberately -- going through that
-- RPC would also have rewritten service.roaster_candidate_clusters.status.
-- So the requeue is explicit here.
--
-- Nulling name_embedding is NOT sufficient on its own. The work queue is
-- public.get_roasters_needing_embeddings, which is:
--
--     WHERE cr.name_embedding IS NULL AND reb.roaster_id IS NULL
--     -- reb = service.roaster_embedding_backfill ... AND reb.success = true
--
-- Four of the seven (564, 885, 984, 1081) carry a success=true ledger row from
-- the 2026-01-27 backfill and would be filtered straight back out. Their ledger
-- rows are cleared so the queue can see them; the other three (1090, 1443,
-- 2328) have no ledger row and no embedding, so they are already queued and
-- are listed only so the set is one thing.
--
-- This does not generate anything. scripts/backfill-roaster-embeddings.ts is
-- the only caller of generate-roaster-embedding and must be run by hand; there
-- is no cron for embeddings. Note it walks the WHOLE queue, which was 942 of
-- 2,011 roasters before this migration -- a real OpenAI spend on
-- OPENAI_API_KEY (the personal key, not _NON_PERSONAL), not just these seven.

delete from service.roaster_embedding_backfill
where roaster_id in (564, 885, 984, 1081);

update public.coffee_roasters
set    name_embedding       = null,
       embedding_updated_at = null
where  id in (564, 885, 984, 1081, 1090, 1443, 2328);
