-- Security F10: private review translations were readable by every user.
--
-- translations_select_authenticated was USING (true), so any signed-in user
-- could list the cached translated text and bean name of private reviews.
-- Reads now follow the parent review at query time: public reviews, or the
-- caller's own. bean_reviews has no owner SELECT policy, so a plain EXISTS in
-- this policy would run under the caller's RLS and hide owners' own private
-- reviews; the check therefore lives in a small SECURITY DEFINER helper.
-- Making a review private hides its cached translations immediately, with no
-- cache purge. Cache writes stay with translate-bean-review (service role),
-- which already checks visibility before reading or writing.
create or replace function public.can_read_bean_review_translation(p_review_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.bean_reviews r
    where r.id = p_review_id
      and (r.is_public = true or r.user_id = (select auth.uid()))
  );
$$;

revoke execute on function public.can_read_bean_review_translation(uuid) from public;
revoke execute on function public.can_read_bean_review_translation(uuid) from anon;
revoke execute on function public.can_read_bean_review_translation(uuid) from authenticated;
grant execute on function public.can_read_bean_review_translation(uuid) to authenticated;
grant execute on function public.can_read_bean_review_translation(uuid) to service_role;
grant execute on function public.can_read_bean_review_translation(uuid) to postgres;

drop policy if exists translations_select_authenticated on public.bean_review_translations;
create policy bean_review_translations_select_visible
on public.bean_review_translations
for select to authenticated
using (public.can_read_bean_review_translation(review_id));

revoke insert, update, delete on public.bean_review_translations from anon;
revoke insert, update, delete on public.bean_review_translations from authenticated;
revoke insert, update, delete on public.bean_review_translations from public;
