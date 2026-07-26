-- ============================================================================
-- MIGRATION A of 2 — ADDITIVE, SAFE. APPLY THIS ONE NOW.
-- ============================================================================
-- Companion file 20260726171500_drop_blog_subscribers_anon_direct_access.sql
-- is Migration B. It is BREAKING until the timer-coffee-landing-2 deploy that
-- switches confirm.ts / unsubscribe.ts / subscribe.ts / notify-subscribers.ts
-- to the RPCs created here has shipped. Do NOT apply Migration B until that
-- deploy is live — it drops the anon SELECT/UPDATE policies this migration's
-- new functions are meant to replace, and the current production landing
-- site still reads/writes public.blog_subscribers directly with those
-- policies. This migration (A) is safe to apply immediately: it only adds
-- new SECURITY DEFINER functions and does not touch existing policies or
-- any caller's behavior.
-- ============================================================================
--
-- Bug being fixed (see Migration B header for the drop): public.blog_subscribers
-- has RLS enabled with:
--   - SELECT for {anon}, qual = true            -> anyone with the publishable
--     key (shipped in the website's client bundle) can read every
--     subscriber's email + token.
--   - UPDATE for {anon}, qual = true, with_check = true -> named "Allow anon
--     update by token" but does not actually check any token; PostgREST's
--     .eq('token', ...) filter is enforced client-side only and is
--     trivially bypassed by calling the REST endpoint directly, letting
--     anyone flip confirmed on/off for any row.
--   - INSERT for {anon}, with_check = false     -> correctly blocked already;
--     src/pages/api/subscribe.ts in the landing repo never inserts directly,
--     it calls the SECURITY DEFINER function add_subscriber(). That is the
--     pattern this migration extends to the confirm/unsubscribe/status-check
--     flows that were never migrated off direct table access.
--
-- This migration mirrors add_subscriber's existing style (plpgsql,
-- SECURITY DEFINER, SET search_path TO 'public', 'extensions', operates only
-- on the single row identified by the caller's token/email — never returns
-- other subscribers' data).

-- ----------------------------------------------------------------------------
-- 1. Extend add_subscriber() to also return `confirmed`.
-- ----------------------------------------------------------------------------
-- Why extend rather than add a separate lookup function: subscribe.ts already
-- calls add_subscriber() and only needs one more piece of information it
-- currently fetches via a follow-up direct
-- `.from('blog_subscribers').select('confirmed').eq('token', ...)` call. The
-- new `confirmed` output column is additive — existing callers that
-- destructure `{ generated_token, already_exists }` from the RPC response are
-- unaffected because Postgres RPC results are returned as JSON objects keyed
-- by column name, and adding a column does not change or shift the existing
-- keys. This avoids introducing a fourth RPC for a one-column lookup.
--
-- Note: CREATE OR REPLACE cannot change the OUT-parameter row type of an
-- existing TABLE-returning function ("Row type defined by OUT parameters is
-- different"), so the old signature must be dropped first.
drop function if exists public.add_subscriber(text);

create function public.add_subscriber(subscriber_email text)
returns table(generated_token uuid, already_exists boolean, confirmed boolean)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
DECLARE
  existing_subscriber RECORD;
  new_token UUID;
BEGIN
  -- Check if email already exists.
  -- NOTE: columns must be qualified with the table alias — this function's
  -- RETURNS TABLE(..., confirmed boolean, ...) makes `confirmed` an
  -- implicit PL/pgSQL variable in scope, which would otherwise collide with
  -- the unqualified public.blog_subscribers.confirmed column reference
  -- ("column reference \"confirmed\" is ambiguous").
  SELECT bs.id, bs.email, bs.confirmed, bs.token INTO existing_subscriber
  FROM public.blog_subscribers bs
  WHERE bs.email = subscriber_email;

  IF FOUND THEN
     -- Return existing token, indicate user already exists, and report
     -- their current confirmation status so the caller no longer needs a
     -- separate direct-table lookup.
     RETURN QUERY SELECT existing_subscriber.token, true, existing_subscriber.confirmed;
  ELSE
      -- Insert new subscriber and return the generated token
      INSERT INTO public.blog_subscribers (email)
      VALUES (subscriber_email)
      RETURNING token INTO new_token;

      RETURN QUERY SELECT new_token, false, false;
  END IF;
END;
$function$;

-- ----------------------------------------------------------------------------
-- 2. confirm_subscription(p_token) — replaces confirm.ts's direct
--    select-then-update-by-token sequence.
-- ----------------------------------------------------------------------------
-- Return shape mirrors the three branches confirm.ts currently distinguishes:
--   found = false                       -> invalid/unknown token
--                                           (redirect ?error=invalid_or_expired_token)
--   found = true,  already_confirmed = false -> just confirmed by this call
--                                           (redirect ?message=confirmed)
--   found = true,  already_confirmed = true  -> token valid, was already
--                                           confirmed before this call
--                                           (redirect ?message=already_confirmed)
-- The UPDATE is scoped to the single row matching p_token (a unique uuid
-- token per subscriber), so this can never confirm or reveal any other
-- subscriber's row.
create or replace function public.confirm_subscription(p_token uuid)
returns table(found boolean, already_confirmed boolean)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
BEGIN
  -- Try to confirm an unconfirmed subscriber matching this token.
  UPDATE public.blog_subscribers
  SET confirmed = true
  WHERE token = p_token AND confirmed = false;

  IF FOUND THEN
    RETURN QUERY SELECT true, false;
    RETURN;
  END IF;

  -- No row was updated: either the token doesn't exist, or it exists but was
  -- already confirmed. Distinguish the two without leaking any other row.
  IF EXISTS (SELECT 1 FROM public.blog_subscribers WHERE token = p_token) THEN
    RETURN QUERY SELECT true, true;
  ELSE
    RETURN QUERY SELECT false, false;
  END IF;
END;
$function$;

-- ----------------------------------------------------------------------------
-- 3. unsubscribe_subscriber(p_token) — replaces unsubscribe.ts's direct
--    update-by-token call.
-- ----------------------------------------------------------------------------
-- unsubscribe.ts sets confirmed = false regardless of current status (a user
-- may unsubscribe before ever confirming) and only needs to know whether a
-- row matched, to choose between the "unsubscribed" and
-- "invalid_unsubscribe_token" redirects. Returns a single boolean rather than
-- a row/table since that is all the caller branches on.
create or replace function public.unsubscribe_subscriber(p_token uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
DECLARE
  updated_count integer;
BEGIN
  UPDATE public.blog_subscribers
  SET confirmed = false
  WHERE token = p_token;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count > 0;
END;
$function$;

-- ----------------------------------------------------------------------------
-- Grants — callable by the anon key, same as the existing add_subscriber().
-- ----------------------------------------------------------------------------
-- None of these functions return the full subscriber list or any row other
-- than the one identified by the caller-supplied token, so granting anon
-- EXECUTE here does not relocate the SELECT-policy leak this fix is for.
grant execute on function public.add_subscriber(text) to anon;
grant execute on function public.confirm_subscription(uuid) to anon;
grant execute on function public.unsubscribe_subscriber(uuid) to anon;
