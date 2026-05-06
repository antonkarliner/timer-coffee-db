-- Scoped access for /admin/recipe-draft-lab without granting full admin rights.

create table if not exists service.recipe_draft_lab_access (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'tester',
  is_active boolean not null default true,
  expires_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  created_by uuid references auth.users(id),
  constraint recipe_draft_lab_access_role_check check (role = 'tester')
);

alter table service.recipe_draft_lab_access enable row level security;

revoke all on table service.recipe_draft_lab_access from anon;
revoke all on table service.recipe_draft_lab_access from authenticated;

grant select, insert, update, delete on table service.recipe_draft_lab_access to service_role;

drop policy if exists "recipe_draft_lab_access_service_role_manage"
  on service.recipe_draft_lab_access;

create policy "recipe_draft_lab_access_service_role_manage"
  on service.recipe_draft_lab_access
  for all
  to service_role
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create index if not exists recipe_draft_lab_access_active_idx
  on service.recipe_draft_lab_access (is_active, expires_at);

comment on table service.recipe_draft_lab_access
  is 'Allowlist for users who may access the website Recipe Draft Lab without full service admin rights.';

comment on column service.recipe_draft_lab_access.expires_at
  is 'Optional UTC expiry; null means the tester access does not expire automatically.';
