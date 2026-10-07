-- Apply only after /api/subscribe proxies to subscribe-blog in production.
revoke execute on function public.add_subscriber(text) from public;
revoke execute on function public.add_subscriber(text) from anon;
revoke execute on function public.add_subscriber(text) from authenticated;
grant execute on function public.add_subscriber(text) to service_role;
grant execute on function public.add_subscriber(text) to postgres;

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
  return query select false, false;
end;
$function$;

revoke execute on function public.confirm_subscription(uuid) from public;
revoke execute on function public.confirm_subscription(uuid) from anon;
revoke execute on function public.confirm_subscription(uuid) from authenticated;
grant execute on function public.confirm_subscription(uuid) to anon, service_role, postgres;
