-- Recipe 601 (Scott Rao Kalita Wave): shorten the final "spin and wait for
-- drawdown" step from 135 s to 60 s in every locale, and lower
-- recipes.brew_time to match the new step sum (260 - 75 = 185).
--
-- The final step is step_order 9 in every locale except es, whose steps are
-- numbered 1..8, so target it as the highest step_order per locale rather
-- than by id. The guard on "time" = '135' keeps this a no-op on replay.

begin;

update public.steps s
set "time" = '60'
where s.recipe_id = '601'
  and s."time" = '135'
  and s.step_order = (
    select max(s2.step_order)
    from public.steps s2
    where s2.recipe_id = s.recipe_id
      and s2.locale = s.locale
  );

update public.recipes
set brew_time = 185,
    last_modified = now()
where id = '601'
  and brew_time = 260;

commit;
