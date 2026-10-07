-- Security F11 (step 1 of 2): newsletter tokens were issued to anyone.
--
-- add_subscriber() is anon-executable and returns the subscriber's token,
-- which confirms AND unsubscribes, never expires, and also re-confirms an
-- unsubscribed address. So anyone could subscribe arbitrary addresses or
-- silently unsubscribe a known subscriber.
--
-- This step separates the two capabilities: request_blog_subscription()
-- (service-only, called by the new subscribe-blog edge function, which emails
-- the link itself) issues a single-use confirmation token that expires after
-- 7 days and is rotated by every new request; the long-lived token remains
-- the unsubscribe credential that existing emails already carry, and is never
-- rotated for a confirmed subscriber. Unsubscribing voids any pending
-- confirmation link.
--
-- For the cutover only, confirm_subscription() still accepts the old token for
-- rows with no confirmation token issued, and add_subscriber stays callable,
-- so the live website keeps working until its release that proxies to
-- subscribe-blog is deployed. Step 2,
-- supabase/deferred-migrations/retire_public_blog_subscriber_issuance.sql,
-- removes both afterwards; see the README there.

alter table public.blog_subscribers
  add column confirmation_token uuid,
  add column confirmation_token_expires_at timestamptz;

create unique index blog_subscribers_confirmation_token_key
  on public.blog_subscribers (confirmation_token)
  where confirmation_token is not null;

create function public.request_blog_subscription(p_email text)
returns table(should_send boolean, confirmation_token uuid, unsubscribe_token uuid)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  normalized_email text := pg_catalog.lower(pg_catalog.btrim(p_email));
  subscriber public.blog_subscribers%rowtype;
  new_confirmation_token uuid;
begin
  if normalized_email is null or normalized_email = ''
     or pg_catalog.length(normalized_email) > 254
     or pg_catalog.strpos(normalized_email, '@') = 0 then
    raise exception 'Invalid email address' using errcode = '22023';
  end if;

  insert into public.blog_subscribers (email) values (normalized_email)
  on conflict (email) do nothing;

  select bs.* into strict subscriber
  from public.blog_subscribers bs
  where bs.email = normalized_email
  for update;

  if subscriber.confirmed then
    return query select false, null::uuid, null::uuid;
    return;
  end if;

  new_confirmation_token := pg_catalog.gen_random_uuid();
  update public.blog_subscribers bs
  set confirmation_token = new_confirmation_token,
      confirmation_token_expires_at = pg_catalog.now() + interval '7 days'
  where bs.id = subscriber.id;
  return query select true, new_confirmation_token, subscriber.token;
end;
$function$;

revoke execute on function public.request_blog_subscription(text) from public;
revoke execute on function public.request_blog_subscription(text) from anon;
revoke execute on function public.request_blog_subscription(text) from authenticated;
grant execute on function public.request_blog_subscription(text) to service_role;
grant execute on function public.request_blog_subscription(text) to postgres;

create or replace function public.confirm_subscription(p_token uuid)
returns table(found boolean, already_confirmed boolean)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  subscriber public.blog_subscribers%rowtype;
begin
  select bs.* into subscriber
  from public.blog_subscribers bs
  where bs.confirmation_token = p_token
    and bs.confirmation_token_expires_at > pg_catalog.now()
  for update;

  if FOUND then
    update public.blog_subscribers bs
    set confirmed = true, confirmation_token = null,
        confirmation_token_expires_at = null
    where bs.id = subscriber.id;
    return query select true, subscriber.confirmed;
    return;
  end if;
  -- Temporary compatibility for confirmation emails issued before this release.
  select bs.* into subscriber
  from public.blog_subscribers bs
  where bs.token = p_token and bs.confirmation_token is null
  for update;

  if FOUND then
    if not subscriber.confirmed then
      update public.blog_subscribers bs set confirmed = true
      where bs.id = subscriber.id;
    end if;
    return query select true, subscriber.confirmed;
    return;
  end if;

  return query select false, false;
end;
$function$;

revoke execute on function public.confirm_subscription(uuid) from public;
revoke execute on function public.confirm_subscription(uuid) from anon;
revoke execute on function public.confirm_subscription(uuid) from authenticated;
grant execute on function public.confirm_subscription(uuid) to anon, service_role, postgres;

create or replace function public.unsubscribe_subscriber(p_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  updated_count integer;
begin
  update public.blog_subscribers bs
  set confirmed = false, confirmation_token = null,
      confirmation_token_expires_at = null
  where bs.token = p_token;

  get diagnostics updated_count = ROW_COUNT;
  return updated_count > 0;
end;
$function$;

revoke execute on function public.unsubscribe_subscriber(uuid) from public;
revoke execute on function public.unsubscribe_subscriber(uuid) from anon;
revoke execute on function public.unsubscribe_subscriber(uuid) from authenticated;
grant execute on function public.unsubscribe_subscriber(uuid) to anon, service_role, postgres;

revoke all on table public.blog_subscribers from anon;
revoke all on table public.blog_subscribers from authenticated;
revoke all on table public.blog_subscribers from public;

-- Keep add_subscriber callable until the website proxy release is live.
