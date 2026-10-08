-- Security F17 (5 of 5): stop trusting a caller-supplied user id in the yearly
-- recap RPCs.
--
-- pick_yearly_wish and yearly_user_liters_percentile were SECURITY DEFINER
-- functions that took p_user_id from the caller, so any signed-in (or anon)
-- caller could mark wishes delivered for another user, or read another user's
-- yearly liters. Released apps (3.9.0+) call them as
--   rpc('pick_yearly_wish', {p_user_id: currentUser.id, p_locale})
--   rpc('yearly_user_liters_percentile', {p_year, p_user_id: currentUser.id, p_liters?})
-- so signatures, argument names, return types, language and volatility stay
-- exactly as they are. Only the source of the user id changes, plus the
-- unreachable 2-argument overload is dropped.
--
-- End state for both remaining functions: {postgres, authenticated, service_role}.

-- 1. pick_yearly_wish: the user is always auth.uid(). p_user_id is kept only so
--    released apps' call signature keeps resolving; it must be null or the
--    caller's own id.
create or replace function public.pick_yearly_wish(p_user_id uuid, p_locale text)
returns table(id uuid, text text, locale text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_lang text := split_part(coalesce(p_locale, ''), '-', 1);
  v_rec record;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if p_user_id is not null and p_user_id <> v_uid then
    raise exception 'p_user_id must be the caller''s own id' using errcode = '42501';
  end if;

  select w.id, w.text, w.locale
  into v_rec
  from public.yearly_wishes w
  where w.status = 'approved'
    and (w.author_user_id is null or w.author_user_id <> v_uid)
    and not exists (
      select 1 from public.yearly_wish_deliveries d
      where d.wish_id = w.id and d.recipient_user_id = v_uid
    )
  order by
    (w.locale = p_locale) desc,
    (w.locale = v_lang) desc,
    (w.locale is null or w.locale = '' or w.locale = 'und') desc,
    w.created_at desc
  limit 1;

  if v_rec.id is null then
    return;
  end if;

  insert into public.yearly_wish_deliveries(wish_id, recipient_user_id)
  values (v_rec.id, v_uid)
  on conflict do nothing;

  return query select v_rec.id, v_rec.text, v_rec.locale;
end $$;

-- 2. Drop the 2-argument yearly_user_liters_percentile overload. It is
--    unreachable: the 3-argument overload's p_liters default makes both
--    candidates match, so every 2-argument call, positional or named (and
--    therefore every PostgREST call that omits p_liters), fails with
--    "function ... is not unique". It is also what makes the app's no-liters
--    call fail today. Dropping it lets those calls resolve to the 3-argument
--    overload below.
drop function public.yearly_user_liters_percentile(integer, uuid);

-- 3. The remaining overload looks the caller's own row up by auth.uid(), never
--    by p_user_id, and returns zero rows when p_user_id names someone else (the
--    app's "no data" path). auth.uid() is null for anon/service_role, so those
--    get my_liters null (and, with a non-null p_user_id, no rows).
create or replace function public.yearly_user_liters_percentile(
  p_year integer,
  p_user_id uuid,
  p_liters double precision default null::double precision
)
returns table(percentile numeric, top_pct integer, liters double precision, active_users integer)
language sql
security definer
set search_path = public
as $$
  with base as (
    select liters
    from public.yearly_user_liters
    where year = p_year and brews >= 1
  ),
  me_val as (
    select coalesce(p_liters, (select liters from public.yearly_user_liters where year = p_year and user_id = auth.uid())) as liters
  ),
  counts as (
    select
      (select count(*) from base where liters < (select liters from me_val)) as less,
      (select count(*) from base where liters = (select liters from me_val)) as equal,
      (select count(*) from base) as n,
      (select liters from me_val) as my_liters
  )
  select
    case when n = 0 then null else 100.0 * (less + 0.5 * equal) / n end as percentile,
    case when n = 0 then null else greatest(1, round(100 - (100.0 * (less + 0.5 * equal) / n))) end as top_pct,
    my_liters,
    n

  from counts
  where p_user_id is null or p_user_id is not distinct from auth.uid();
$$;

-- 4. Grants. CREATE OR REPLACE keeps existing ACLs, but restate the end state by
--    name (default privileges grant anon EXECUTE on new functions).
revoke execute on function public.pick_yearly_wish(uuid, text) from public;
revoke execute on function public.pick_yearly_wish(uuid, text) from anon;
revoke execute on function public.pick_yearly_wish(uuid, text) from authenticated;
grant  execute on function public.pick_yearly_wish(uuid, text) to authenticated;
grant  execute on function public.pick_yearly_wish(uuid, text) to service_role;
grant  execute on function public.pick_yearly_wish(uuid, text) to postgres;

revoke execute on function public.yearly_user_liters_percentile(integer, uuid, double precision) from public;
revoke execute on function public.yearly_user_liters_percentile(integer, uuid, double precision) from anon;
revoke execute on function public.yearly_user_liters_percentile(integer, uuid, double precision) from authenticated;
grant  execute on function public.yearly_user_liters_percentile(integer, uuid, double precision) to authenticated;
grant  execute on function public.yearly_user_liters_percentile(integer, uuid, double precision) to service_role;
grant  execute on function public.yearly_user_liters_percentile(integer, uuid, double precision) to postgres;

-- Guard: fail the migration if any function is left with the wrong end state.
do $$
declare
  fn regprocedure;
  fns regprocedure[] := array[
    'public.pick_yearly_wish(uuid, text)'::regprocedure,
    'public.yearly_user_liters_percentile(integer, uuid, double precision)'::regprocedure
  ];
begin
  if to_regprocedure('public.yearly_user_liters_percentile(integer,uuid)') is not null then
    raise exception 'the 2-argument yearly_user_liters_percentile overload still exists';
  end if;

  foreach fn in array fns loop
    if has_function_privilege('anon', fn, 'execute') then
      raise exception 'anon can still execute %', fn;
    end if;
    if has_function_privilege('authenticated', fn, 'execute') is distinct from true then
      raise exception 'authenticated cannot execute %', fn;
    end if;
    if has_function_privilege('service_role', fn, 'execute') is distinct from true then
      raise exception 'service_role cannot execute %', fn;
    end if;
    if exists (
      select 1
      from pg_proc p
      where p.oid = fn
        and (
          p.proacl is null
          or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
        )
    ) then
      raise exception 'PUBLIC still holds an execute grant on %', fn;
    end if;
    if not exists (
      select 1
      from pg_proc p
      where p.oid = fn
        and p.prosecdef
        and p.proconfig = array['search_path=public']::text[]
    ) then
      raise exception '% must be security definer with search_path=public', fn;
    end if;
  end loop;
end $$;
