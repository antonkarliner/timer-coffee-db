-- Two follow-ups to 20260917150000 (plan 036).
--
-- ---------------------------------------------------------------------------
-- A. Reattach the beans that merge groups 4 and 9 freed but did not link.
--
-- 20260917150000 removed the norm_terms ambiguity on 'sightglass',
-- 'sightglass coffee' and 'cafe pista' by deleting the duplicate rows, which
-- is what was blocking public.resolve_coffee_roaster_id (it returns NULL, not
-- an arbitrary row, when two roasters claim a term). But the reattach only
-- happens via trg_attach_pending_global_beans, which fires on
-- UPDATE OF roaster_name, aliases -- and those two groups were the ones whose
-- survivor already carried the loser's name as an alias, so no UPDATE ran and
-- no attach_beans job was enqueued. Verified after the push: 14 attach_beans
-- jobs succeeded, none of them for 409 or 1276, and all 8 beans stayed NULL.
--
-- public.attach_pending_global_beans_for_roaster carries its own ambiguity
-- guard (it only claims terms held by exactly one roaster), so calling it
-- directly is equivalent to what the worker would have done.

select public.attach_pending_global_beans_for_roaster(409);   -- Sightglass Coffee
select public.attach_pending_global_beans_for_roaster(1276);  -- Pista

-- ---------------------------------------------------------------------------
-- B. Move 11 misattributed beans from 508 (Kawa, Hannover) to 709 (Tanat, Paris).
--
-- Surfaced by the ambiguous-norm_terms detector in plan 036 section 1.2, which
-- the name-stem/website-host detector cannot reach: these are two different
-- businesses, not a duplicate pair, so there is nothing to merge -- the beans
-- are simply on the wrong roaster.
--
--   508 "Kawa"  -> kawathehut.com, Staerkestr 26, Hannover. A cafe
--                  ("Coffee, Bakery and More"); no evidence it roasts or bags.
--   709 "Tanat" -> tanat.coffee, Paris, VAYGA SAS, alias "Kawa".
--                  The site states "Kawa becomes Tanat" and still runs
--                  pro.kawa.coffee, so the alias records a real rebrand.
--
-- Both rows therefore claim the bare term 'kawa' legitimately, and every bean
-- a user scans as "Kawa" has been landing on 508. Attribution evidence for
-- these 11 specifically, cross-referenced against the 50 beans already on 709:
--
--   * "Nestor Lasso" (Colombia, Huila) -- 709 carries five Nestor Lasso lots
--     from the same farm and region.
--   * "Salvador - San Francisco [Laurina]" -- 709's house naming format is
--     "Country - Farm [Process]": "Colombie - Las Flores [Anaerobic Decaf]",
--     "Kenya - Ruera Estate [PB Washed #031]", "Bolivie - Los Rodriguez
--     [SL-28 Honey]". 508 has no such convention.
--   * One bean is named "Tanat" outright, origin "Bresil, Guatemala, Perou".
--   * French origin spellings ("Bresil") on rows attributed to a German cafe.
--
-- Listed by bean id rather than by roaster so this is reversible and so a bean
-- added to 508 after this plan was written is not swept along.

update public.global_coffee_beans
set    coffee_roaster_id = 709
where  coffee_roaster_id = 508
  and  id in (1504, 1663, 2507, 4271, 5339, 5340, 5342, 9788, 10972, 10973, 12300);

-- The 'kawa' term stays ambiguous on purpose. Breaking the tie needs one of
-- the two rows to stop claiming it, and both claims are real: 508 is named
-- Kawa and 709's alias records the rebrand. Dropping 709's alias would point
-- future "Kawa" scans at the Hannover cafe, which is the error this migration
-- just corrected. Renaming 508 to its domain name ("Kawa the Hut") would free
-- the term, but that is a call about someone's business name, not a data fix.
-- Until then resolve_coffee_roaster_id returns NULL for "Kawa" -- unlinked,
-- which is recoverable, rather than linked to the wrong roaster, which is not.
-- Same reasoning as 'koa' in plan 036 section 2.3.
