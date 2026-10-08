-- Security F11 follow-up: throttle confirmation emails per address.
--
-- request_blog_subscription() issued a fresh confirmation token, and so
-- subscribe-blog sent a fresh email, on every request for a pending address.
-- The per-IP rate limit was the only thing between one solver of Turnstile
-- challenges and a victim's inbox. Now a pending address whose current
-- confirmation link was issued less than 10 minutes ago gets no new token and
-- no email: the response is the same (false, null, null) as for a confirmed
-- address, so subscribe-blog still answers with its generic success message
-- and the already-sent link stays valid.
--
-- Issue time is derived from the expiry, which is always set to issue time
-- + 7 days; confirm_subscription() and unsubscribe_subscriber() null both
-- columns, so a consumed or voided link never throttles.
--
-- CREATE OR REPLACE keeps the ACL but resets proconfig, so search_path is
-- re-declared below and the grants are re-stated for the record.

create or replace function public.request_blog_subscription(p_email text)
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

  -- Issued less than 10 minutes ago: keep the link already sent.
  if subscriber.confirmation_token is not null
     and subscriber.confirmation_token_expires_at
       > pg_catalog.now() + interval '7 days' - interval '10 minutes' then
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
