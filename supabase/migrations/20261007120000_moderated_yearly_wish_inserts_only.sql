-- Security F09: direct wish inserts bypassed moderation.
--
-- yearly_wishes_insert_own let any signed-in user insert their own row through
-- PostgREST with any status, including 'approved', and the approved-only picker
-- then delivered it to other users. The only legitimate writer is the
-- submit-yearly-wish edge function, which moderates the text and inserts with
-- the service role, so client roles lose INSERT (and the UPDATE/DELETE they
-- never had a policy for). Owners keep reading their own wishes.
drop policy if exists yearly_wishes_insert_own on public.yearly_wishes;

revoke insert, update, delete on public.yearly_wishes from anon;
revoke insert, update, delete on public.yearly_wishes from authenticated;
revoke insert, update, delete on public.yearly_wishes from public;
