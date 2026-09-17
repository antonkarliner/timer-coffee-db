-- Merge 9 confirmed duplicate roaster pairs in public.coffee_roasters.
--
-- Evidence and per-pair verification: plans/036-coffee-roasters-duplicate-merge.md
--
-- Each pair was confirmed against the live website AND against the beans
-- attributed to each row -- not on name similarity. Seven further pairs that
-- the same detectors surfaced are deliberately NOT merged (plan section 2.2);
-- four ambiguous norm_terms between genuinely distinct roasters are left alone
-- and recorded in section 2.3.
--
-- Creates no tables, functions or views, so there is nothing here for the
-- RLS / explicit-GRANT / revoke-EXECUTE rules to attach to.
--
-- norm_terms on both coffee_roasters and roaster_profiles is GENERATED ALWAYS
-- ... STORED, so folding the loser's name into the survivor's aliases is what
-- keeps future scans of that name resolving. Do not write norm_terms directly.
--
-- No explicit BEGIN/COMMIT: the Supabase CLI wraps each migration file in its
-- own transaction (no other migration in this repo opens one), and an inner
-- COMMIT would close that transaction before the schema_migrations insert.

create temporary table merge_pairs (
  survivor_id bigint not null,
  loser_id    bigint not null,
  fold_alias  text             -- null when the survivor already carries it
) on commit drop;

insert into merge_pairs (survivor_id, loser_id, fold_alias) values
  ( 885,   69, 'Gringo Nordic,Gringo'),        -- gringonordic.se, same address
  ( 984, 1263, 'Drop Coffee'),                 -- dropcoffee.com
  ( 564,  239, 'Rave'),                        -- ravecoffee.co.uk, same address
  ( 409,  114, null),                          -- 409 already aliases Sightglass
  (1090,  354, 'Bailies Cofffee Roasters'),    -- triple-f typo, kept for text resolution
  (1081,  459, 'Arcade'),                      -- both Riverside, California
  (1443,  791, 'Exhale'),                      -- Higham Miller Coffee Ltd, London
  (2328,  389, 'Passenger Coffee'),            -- same coffees on both rows
  (1276, 1053, null);                          -- 1276 already aliases Cafe Pista

-- Guard: refuse to run if the catalog has drifted from what was reviewed.
do $$
declare
  v_missing int;
begin
  select count(*) into v_missing
  from merge_pairs mp
  where not exists (select 1 from public.coffee_roasters where id = mp.survivor_id)
     or not exists (select 1 from public.coffee_roasters where id = mp.loser_id);
  if v_missing > 0 then
    raise exception
      'merge aborted: % pair(s) reference a roaster id that no longer exists; re-review plan 036 section 2',
      v_missing;
  end if;
end $$;

-- 1. Repoint the declared FK that carries the bag counts.
update public.global_coffee_beans b
set    coffee_roaster_id = mp.survivor_id
from   merge_pairs mp
where  b.coffee_roaster_id = mp.loser_id;

-- 2. Repoint the contribution ledger (its FK is ON DELETE SET NULL; letting it
--    fire would silently drop the attribution).
update service.roaster_candidate_contributions c
set    resolved_roaster_id = mp.survivor_id
from   merge_pairs mp
where  c.resolved_roaster_id = mp.loser_id;

-- 3. Repoint the cluster pointer. This column has NO foreign key, so nothing
--    would have told us it had gone dangling.
update service.roaster_candidate_clusters cc
set    best_match_roaster_id = mp.survivor_id,
       updated_at            = now()
from   merge_pairs mp
where  cc.best_match_roaster_id = mp.loser_id;

-- 4. Backfill ledgers key on roaster_id, so repointing would collide with the
--    survivor's own row. Drop the loser's.
delete from service.roaster_embedding_backfill eb
using merge_pairs mp where eb.roaster_id = mp.loser_id;

delete from service.roaster_dominant_color_backfill db
using merge_pairs mp where db.roaster_id = mp.loser_id;

-- 5. Move any bean review off the losing profile before that profile dies.
--    Zero rows on 2026-09-17; present so a later run cannot fail here.
update public.bean_reviews br
set    roaster_profile_id = sp.id
from   merge_pairs mp
join   public.roaster_profiles lp on lp.coffee_roaster_id = mp.loser_id
join   public.roaster_profiles sp on sp.coffee_roaster_id = mp.survivor_id
where  br.roaster_profile_id = lp.id;

-- 6. Fold the loser's name into the survivor's aliases. This is the whole point
--    of the merge: global_coffee_beans.roaster, user_coffee_beans.roaster and
--    bean_reviews.roaster_name are free text with no key, and alias resolution
--    is the only path they have. Fires maintain_normalized_names,
--    trg_sync_roaster_profile and trg_attach_pending_global_beans.
update public.coffee_roasters cr
set    aliases = nullif(concat_ws(',', nullif(cr.aliases, ''), mp.fold_alias), '')
from   merge_pairs mp
where  cr.id = mp.survivor_id
  and  mp.fold_alias is not null;

-- 7. Retire the losing profile, then the losing roaster.
--    roaster_postprocess_jobs cascades on the roaster delete.
delete from public.roaster_profiles p
using merge_pairs mp where p.coffee_roaster_id = mp.loser_id;

delete from public.coffee_roasters cr
using merge_pairs mp where cr.id = mp.loser_id;

-- 8. Hygiene: seven rows carry the literal string '{}' in aliases, which
--    roaster_norm_terms turns into a '{}' term. Unrelated to the merge, one
--    statement, no risk.
update public.coffee_roasters
set    aliases = null
where  aliases ~ '^\s*\{\s*\}\s*$';
