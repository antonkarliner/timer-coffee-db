-- Correct coffee_roasters id 703 "KBNK": wrong location and a country-name alias.
--
-- Found 2026-09-18 while labelling the plan-034 section 2.1 disagreement set.
-- A real scan printed the roaster line as "KBNK Киев, Украина" (Kyiv, Ukraine)
-- and Jev linked it to 703 at p=0.94, while the row said Saint Petersburg,
-- Russia. The operator confirmed the catalog was wrong, not the link: KBNK is
-- in Kyiv.
--
-- Two defects on the row, both fixed here:
--
-- 1. city/country were "Saint Petersburg" / "Russia". Set to "Kyiv" /
--    "Ukraine", the spelling the other 9 Kyiv roasters in the catalog use.
--
-- 2. aliases was 'KBNK Киев,Украина'. The column is comma-separated (see
--    public.maintain_normalized_names), so the roaster line's own comma split
--    it into TWO aliases: 'KBNK Киев' and a bare 'Украина' ("Ukraine"). A
--    country name as an alias means any scan whose roaster field reads just
--    "Украина" exact-alias-matches KBNK at 0.96 in
--    find_potential_roaster_matches. Checked catalog-wide for country names as
--    aliases (Russian, Ukrainian and English forms of the common origins):
--    this is the only row affected. The 'KBNK Киев' form is kept, since it is
--    how the brand prints on bags.
--
-- Side effects, all intended: maintain_normalized_names recomputes
-- normalized_aliases; the alias change re-enqueues embedding generation and
-- bean attachment; sync_roaster_profile_on_update carries the location to
-- roaster_profiles.
--
-- Guarded: updates only the row in its known pre-image and raises otherwise,
-- so a re-run or a row edited in the meantime fails loudly instead of
-- overwriting someone else's correction.

do $$
declare
  v_updated integer;
begin
  update public.coffee_roasters
     set city    = 'Kyiv',
         country = 'Ukraine',
         aliases = 'KBNK Киев'
   where id = 703
     and roaster_name = 'KBNK'
     and city = 'Saint Petersburg'
     and country = 'Russia'
     and aliases = 'KBNK Киев,Украина';

  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception
      'KBNK fix: expected to update exactly 1 row in its known pre-image, updated %. Re-read id 703 before retrying.',
      v_updated;
  end if;
end $$;
