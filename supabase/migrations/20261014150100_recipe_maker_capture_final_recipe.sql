-- Plan 043 Phase 6.2: captures also record the notice and the recipe saved.
-- Every consented non-admin parse is captured; service admins keep opt-in.
-- Account deletion hard-deletes auth.users, so captures cascade-delete too.
-- Production checked on 2026-10-14: 301 rows, no orphan user_id values; the
-- foreign key is validated immediately. The user_id index serves cascades
-- and deletion-by-request. RLS remains enabled with no client policies.

alter table service.parse_user_recipe_draft_captures
    add column notice_version text,
    add column final_recipe jsonb
        check (final_recipe is null or jsonb_typeof(final_recipe) = 'object'),
    add column final_saved_at timestamptz,
    add constraint parse_user_recipe_draft_captures_user_id_fkey
        foreign key (user_id) references auth.users(id) on delete cascade;

create index parse_user_recipe_draft_captures_user_id_idx
    on service.parse_user_recipe_draft_captures (user_id);

comment on column service.parse_user_recipe_draft_captures.notice_version is
    'Consent notice version for a non-admin parse; null for service-admin opt-in captures made without the notice.';
comment on column service.parse_user_recipe_draft_captures.final_recipe is
    'Recipe object finally saved by the capture owner. A later save overwrites it; attachment is allowed only for captures with a notice version.';
comment on column service.parse_user_recipe_draft_captures.final_saved_at is
    'Server timestamp of the latest final-recipe attachment.';
comment on table service.parse_user_recipe_draft_captures is
    'Per-stage diagnostic captures (request text, raw LLM stage outputs and response) for every consented non-admin parse and service-admin opt-in capture_stages requests. Includes the consent notice version and the recipe finally saved. Kept 12 months; cascade-deleted with the auth user.';

-- Production ACL was {postgres=arwdDxt, anon=arwd, authenticated=arwd,
-- service_role=arwdDxt}. Remove leftover default client grants by name;
-- TRUNCATE is not restrained by RLS. UUID primary key: there is no sequence.
revoke all on table service.parse_user_recipe_draft_captures from anon;
revoke all on table service.parse_user_recipe_draft_captures from authenticated;
grant select, insert, update, delete on table service.parse_user_recipe_draft_captures to service_role;

-- Guard: neither client role may hold any privilege on the two tables that
-- hold Recipe Maker data (the consent table was created in 20261014150000).
do $$
declare
  t text;
  p text;
begin
  foreach t in array array[
    'service.parse_user_recipe_draft_captures',
    'service.recipe_maker_consent'
  ] loop
    foreach p in array array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
      if has_table_privilege('anon', t, p) or has_table_privilege('authenticated', t, p) then
        raise exception 'a client role still holds % on %', p, t;
      end if;
    end loop;
  end loop;
end $$;

create function public.attach_recipe_maker_final(p_capture_id uuid, p_final jsonb)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
    if auth.uid() is null then
        raise exception 'Authentication required' using errcode = '42501';
    end if;
    if p_capture_id is null or p_final is null or jsonb_typeof(p_final) <> 'object' then
        raise exception 'Invalid final recipe attachment' using errcode = '22023';
    end if;
    -- Oversized objects use 22023 (invalid parameter), like other bad inputs.
    if octet_length(p_final::text) > 65536 then
        raise exception 'final_recipe_too_large' using errcode = '22023';
    end if;

    update service.parse_user_recipe_draft_captures
    set final_recipe = p_final, final_saved_at = now()
    where id = p_capture_id and user_id = auth.uid() and notice_version is not null;

    -- Missing, another user's and admin opt-in captures all return false.
    return found;
end;
$$;

revoke execute on function public.attach_recipe_maker_final(uuid, jsonb) from public;
revoke execute on function public.attach_recipe_maker_final(uuid, jsonb) from anon;
revoke execute on function public.attach_recipe_maker_final(uuid, jsonb) from authenticated;
grant execute on function public.attach_recipe_maker_final(uuid, jsonb) to authenticated;
grant execute on function public.attach_recipe_maker_final(uuid, jsonb) to service_role;
grant execute on function public.attach_recipe_maker_final(uuid, jsonb) to postgres;

-- Guard: fail the migration if any function is left with the wrong end state.
do $$
declare
  fn regprocedure;
  fns regprocedure[] := array[
    'public.attach_recipe_maker_final(uuid, jsonb)'::regprocedure
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
