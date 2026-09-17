-- Clear 10 false success=true rows in service.roaster_embedding_backfill.
--
-- Found 2026-09-17 while draining the embedding backlog for plan 036 section
-- 10: the queue reported 0 remaining while only 1,992 of 2,002 roasters had a
-- name_embedding. public.get_roasters_needing_embeddings filters
--
--     WHERE cr.name_embedding IS NULL
--       AND reb.roaster_id IS NULL   -- reb joined ON reb.success = true
--
-- so a ledger row claiming success permanently hides a roaster that has no
-- embedding. These 10 all carry attempted_at = 2026-01-27, the original
-- backfill run, and error_message is null on every one -- the ledger recorded
-- a success that never produced a vector. They have been invisible to every
-- backfill since. Unrelated to the 036 merge; the merge is simply what caused
-- the backlog to be drained far enough for 10 stragglers to be visible.
--
--   201 Ceremony Coffee Roasters      519 JB Kaffee
--   229 Lavazza                       768 Patria Coffee Roasters
--   251 La Cabra                      786 Kanga Roasters
--   253 kaffeemacher:innen            980 S&W Craft Roasting
--   482 Greater Goods Coffee Roasters 1000 Tandem Coffee Roasters
--
-- Deleting the ledger row is the same remedy 20260917170000 applied to the
-- four merge survivors. It only returns these rows to the work queue; the
-- vectors are generated separately by dispatching generate-roaster-embedding
-- (see plan 036 section 10.1 for the pg_net snippet).
--
-- Not fixed here: whatever wrote success=true without an embedding in January.
-- If a re-dispatch of these 10 succeeds, the write path is fine today and the
-- January run is the anomaly; if any fail the same way, the ledger write needs
-- to move behind the embedding write. Recorded in plan 036 section 10.

delete from service.roaster_embedding_backfill
where roaster_id in (201, 229, 251, 253, 482, 519, 768, 786, 980, 1000)
  and success = true
  and roaster_id in (select id from public.coffee_roasters where name_embedding is null);
