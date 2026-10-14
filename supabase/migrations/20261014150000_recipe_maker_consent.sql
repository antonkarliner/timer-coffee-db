-- Plan 043 Phase 6.2: versioned beta data-sharing consent for Recipe Maker.
-- Roaster admins and testers must accept the current notice before parsing.
-- Service admins are exempt. Each acceptance keeps its first timestamp and
-- cascade-deletes with the auth user; old notice acceptances do not authorize
-- a new version. The edge function reads status through the service role.
--
-- `service` default grants include anon/authenticated CRUD, so revoke both
-- by name. RLS has no policies; only postgres and service_role may access rows.
-- The composite UUID/text primary key has no sequence.

create table service.recipe_maker_consent (
    user_id uuid not null references auth.users(id) on delete cascade,
    notice_version text not null check (char_length(notice_version) between 1 and 64),
    accepted_at timestamptz not null default now(),
    primary key (user_id, notice_version)
);

comment on table service.recipe_maker_consent is
    'Versioned Recipe Maker beta data-sharing acceptances. First acceptance is preserved per user/version; rows cascade-delete with the auth user.';

alter table service.recipe_maker_consent enable row level security;
revoke all on table service.recipe_maker_consent from anon;
revoke all on table service.recipe_maker_consent from authenticated;
revoke all on table service.recipe_maker_consent from public;
grant select, insert, update, delete on table service.recipe_maker_consent to service_role;

-- Single source of truth. A future notice change replaces this function.
-- CREATE OR REPLACE wipes a function's SET search_path, so a replacement
-- must re-declare it.
create function service.recipe_maker_current_notice_version()
returns text
language sql
immutable
set search_path = ''
as $$
    select '2026-10-beta-1'::text;
$$;

create function service.recipe_maker_consent_status(p_user_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
    select jsonb_build_object(
        'notice_version', v.notice_version,
        'accepted', c.user_id is not null,
        'accepted_at', c.accepted_at
    )
    from (select service.recipe_maker_current_notice_version() as notice_version) v
    left join service.recipe_maker_consent c
        on c.user_id = p_user_id and c.notice_version = v.notice_version;
$$;

create function public.get_recipe_maker_consent()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if auth.uid() is null then
        raise exception 'Authentication required' using errcode = '42501';
    end if;
    return service.recipe_maker_consent_status(auth.uid());
end;
$$;

create function public.accept_recipe_maker_notice(p_notice_version text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_current_version text := service.recipe_maker_current_notice_version();
begin
    if auth.uid() is null then
        raise exception 'Authentication required' using errcode = '42501';
    end if;
    if p_notice_version is distinct from v_current_version then
        raise exception 'notice_version_mismatch'
            using errcode = '22023', detail = v_current_version;
    end if;

    insert into service.recipe_maker_consent (user_id, notice_version)
    values (auth.uid(), v_current_version)
    on conflict (user_id, notice_version) do nothing;

    return service.recipe_maker_consent_status(auth.uid());
end;
$$;

-- Default EXECUTE grants name anon/authenticated/service_role explicitly;
-- revoking PUBLIC alone would leave client access to internal functions.
revoke execute on function service.recipe_maker_current_notice_version() from public;
revoke execute on function service.recipe_maker_current_notice_version() from anon;
revoke execute on function service.recipe_maker_current_notice_version() from authenticated;
grant execute on function service.recipe_maker_current_notice_version() to service_role;
grant execute on function service.recipe_maker_current_notice_version() to postgres;

revoke execute on function service.recipe_maker_consent_status(uuid) from public;
revoke execute on function service.recipe_maker_consent_status(uuid) from anon;
revoke execute on function service.recipe_maker_consent_status(uuid) from authenticated;
grant execute on function service.recipe_maker_consent_status(uuid) to service_role;
grant execute on function service.recipe_maker_consent_status(uuid) to postgres;

revoke execute on function public.get_recipe_maker_consent() from public;
revoke execute on function public.get_recipe_maker_consent() from anon;
revoke execute on function public.get_recipe_maker_consent() from authenticated;
grant execute on function public.get_recipe_maker_consent() to authenticated;
grant execute on function public.get_recipe_maker_consent() to service_role;
grant execute on function public.get_recipe_maker_consent() to postgres;

revoke execute on function public.accept_recipe_maker_notice(text) from public;
revoke execute on function public.accept_recipe_maker_notice(text) from anon;
revoke execute on function public.accept_recipe_maker_notice(text) from authenticated;
grant execute on function public.accept_recipe_maker_notice(text) to authenticated;
grant execute on function public.accept_recipe_maker_notice(text) to service_role;
grant execute on function public.accept_recipe_maker_notice(text) to postgres;

-- Guard: fail the migration if any function is left with the wrong end state.
do $$
declare
  fn regprocedure;
  fns regprocedure[] := array[
    'service.recipe_maker_current_notice_version()'::regprocedure,
    'service.recipe_maker_consent_status(uuid)'::regprocedure
  ];
begin
  foreach fn in array fns loop
    if has_function_privilege('anon', fn, 'execute') then
      raise exception 'anon can still execute %', fn;
    end if;
    if has_function_privilege('authenticated', fn, 'execute') is distinct from false then
      raise exception 'authenticated execute on % should be false', fn;
    end if;
    if has_function_privilege('service_role', fn, 'execute') is distinct from true then
      raise exception 'service_role cannot execute %', fn;
    end if;
    if has_function_privilege('postgres', fn, 'execute') is distinct from true then
      raise exception 'postgres cannot execute %', fn;
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
  end loop;
end $$;

-- Guard: fail the migration if any function is left with the wrong end state.
do $$
declare
  fn regprocedure;
  fns regprocedure[] := array[
    'public.get_recipe_maker_consent()'::regprocedure,
    'public.accept_recipe_maker_notice(text)'::regprocedure
  ];
begin
  foreach fn in array fns loop
    if has_function_privilege('anon', fn, 'execute') then
      raise exception 'anon can still execute %', fn;
    end if;
    if has_function_privilege('authenticated', fn, 'execute') is distinct from true then
      raise exception 'authenticated execute on % should be true', fn;
    end if;
    if has_function_privilege('service_role', fn, 'execute') is distinct from true then
      raise exception 'service_role cannot execute %', fn;
    end if;
    if has_function_privilege('postgres', fn, 'execute') is distinct from true then
      raise exception 'postgres cannot execute %', fn;
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
  end loop;
end $$;
