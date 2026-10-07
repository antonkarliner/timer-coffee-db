-- Security F12/F13: label parsing trusted a body userId and charged OCR-only
-- work zero units, with a read-count-then-call quota check.
--
-- parse-coffee-label and parse-coffee-label-gemini now take the caller from
-- the JWT (anonymous guest sessions included) and reserve recognition units
-- through service.reserve_label_parse_units before any provider request. The
-- reservation is a row in parse_coffee_label_invocations itself, so it counts
-- toward the UTC-month allowance immediately, serialised per user by an
-- advisory lock, and moves with the account when a guest signs in. It is
-- finalised as succeeded or failed_billed, or released (deleted) only when no
-- provider request was sent. Failed provider work is therefore charged.
--
-- The column defaults mark existing rows, and rows written by the previously
-- deployed handlers during cutover, as succeeded.
alter table public.parse_coffee_label_invocations
  add column status text not null default 'succeeded' check (status in ('reserved', 'succeeded', 'failed_billed')),
  add column route text,
  add column completed_at timestamptz;

-- Existing parse_coffee_label_invocation_user_id_invoked_at_tokens_use_idx
-- covers (user_id, invoked_at), including tokens_used for the monthly sum.
-- TRUNCATE is also granted by the initial schema and bypasses RLS.
revoke select, insert, update, delete, truncate on table public.parse_coffee_label_invocations from anon, authenticated, public;
revoke select, insert, update, delete, truncate on table public.pro_users from anon, authenticated, public;
-- Resolve the identity sequence rather than relying on an implicit generated name.
do $$
begin
  execute format('revoke usage, select on sequence %s from anon, authenticated',
    pg_get_serial_sequence('public.parse_coffee_label_invocations', 'id'));
end $$;

create or replace function service.reserve_label_parse_units(p_user_id uuid, p_units integer, p_limit integer, p_route text)
returns table (admitted boolean, reservation_id bigint, used bigint)
language plpgsql security invoker set search_path = '' as $$
begin
  if p_user_id is null or p_units is null or p_units not between 1 and 2
    or p_limit is null or p_limit <= 0 or p_route is null or p_route not in ('primary', 'gemini') then
    raise exception 'Invalid label parse reservation arguments' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('label-parse-quota:' || p_user_id::text, 0));
  select coalesce(sum(i.tokens_used), 0) into used
  from public.parse_coffee_label_invocations i
  where i.user_id = p_user_id and i.invoked_at >= date_trunc('month', now(), 'UTC');
  if used + p_units > p_limit then
    return query select false, null::bigint, used;
    return;
  end if;
  insert into public.parse_coffee_label_invocations (user_id, invoked_at, tokens_used, status, route)
  values (p_user_id, now(), p_units, 'reserved', p_route)
  returning id into reservation_id;
  return query select true, reservation_id, used;
end $$;

create or replace function service.finalize_label_parse_reservation(p_reservation_id bigint, p_outcome text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare changed bigint;
begin
  if p_outcome = 'released' then
    delete from public.parse_coffee_label_invocations where id = p_reservation_id and status = 'reserved';
  elsif p_outcome in ('succeeded', 'failed_billed') then
    update public.parse_coffee_label_invocations set status = p_outcome, completed_at = now()
    where id = p_reservation_id and status = 'reserved';
  else
    raise exception 'Invalid label parse outcome' using errcode = '22023';
  end if;
  get diagnostics changed = row_count;
  return changed > 0;
end $$;

revoke execute on function service.reserve_label_parse_units(uuid, integer, integer, text) from public;
revoke execute on function service.reserve_label_parse_units(uuid, integer, integer, text) from anon;
revoke execute on function service.reserve_label_parse_units(uuid, integer, integer, text) from authenticated;
grant execute on function service.reserve_label_parse_units(uuid, integer, integer, text) to service_role;
grant execute on function service.reserve_label_parse_units(uuid, integer, integer, text) to postgres;
revoke execute on function service.finalize_label_parse_reservation(bigint, text) from public;
revoke execute on function service.finalize_label_parse_reservation(bigint, text) from anon;
revoke execute on function service.finalize_label_parse_reservation(bigint, text) from authenticated;
grant execute on function service.finalize_label_parse_reservation(bigint, text) to service_role;
grant execute on function service.finalize_label_parse_reservation(bigint, text) to postgres;
