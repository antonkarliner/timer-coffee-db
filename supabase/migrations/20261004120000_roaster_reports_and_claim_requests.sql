-- Plan 078, Phase 1: roaster page error reports and claim requests.
--
-- service.roaster_reports holds app/web reports about a roaster page
-- ("wrong location", "closed", "not a roaster", ...) for the operator queue.
-- service.roaster_claim_requests holds "this is my roastery" requests from
-- the public website, one pending request per roaster + email.
--
-- Both are written only by the submit-roaster-feedback edge function with
-- the service role, so there are deliberately no insert policies for
-- anon/authenticated and no table grants to anon. Admins read and update
-- through RLS (public.is_admin()); service_role keeps full access.
-- No new functions.

-- ─── service.roaster_reports ────────────────────────────────────────────────

create table service.roaster_reports (
  id                 uuid primary key default gen_random_uuid(),
  roaster_profile_id uuid not null
    references public.roaster_profiles(id) on delete cascade,
  category           text not null check (category in (
    'wrong_location', 'wrong_website', 'wrong_social', 'wrong_logo',
    'wrong_name', 'wrong_business', 'not_a_roaster', 'closed', 'duplicate',
    'other')),
  suggested_value    text check (char_length(suggested_value) <= 500),
  details            text check (char_length(details) <= 1000),
  contact_email      text check (char_length(contact_email) <= 254),
  source             text not null check (source in ('app', 'web')),
  user_id            uuid,  -- no FK: public user tables do not reference auth.users
  status             text not null default 'new' check (status in (
    'new', 'fixed', 'no_change', 'spam')),
  resolution_note    text,
  resolved_by        uuid,
  resolved_at        timestamptz,
  created_at         timestamptz not null default now()
);

create index if not exists idx_roaster_reports_status_created_at
  on service.roaster_reports (status, created_at desc);
create index if not exists idx_roaster_reports_roaster_profile_id
  on service.roaster_reports (roaster_profile_id);

alter table service.roaster_reports enable row level security;

create policy "roaster_reports_read_admin"
  on service.roaster_reports
  for select
  using (public.is_admin());

create policy "roaster_reports_update_admin"
  on service.roaster_reports
  for update
  using (public.is_admin())
  with check (public.is_admin());

create policy "roaster_reports_service_role_manage"
  on service.roaster_reports
  for all
  using ((select auth.role()) = 'service_role')
  with check ((select auth.role()) = 'service_role');

-- Edge function (service role) writes; anon/authenticated have no insert
-- path. service tables are PostgREST-exposed and default privileges grant
-- anon/authenticated full CRUD on new tables, so revoke explicitly and
-- re-grant only the admin review surface (RLS limits it to is_admin()).
revoke all on service.roaster_reports from anon, authenticated;
grant select, update on service.roaster_reports to authenticated;
grant all on service.roaster_reports to service_role;

comment on table service.roaster_reports is
  'Roaster page error reports submitted from the app or website (plan 078).';

-- ─── service.roaster_claim_requests ─────────────────────────────────────────

create table service.roaster_claim_requests (
  id                   uuid primary key default gen_random_uuid(),
  roaster_profile_id   uuid not null
    references public.roaster_profiles(id) on delete cascade,
  email                text not null
    check (email = lower(email) and char_length(email) <= 254),
  full_name            text not null
    check (char_length(full_name) between 1 and 120),
  role                 text not null check (role in
    ('owner', 'employee', 'agency', 'other')),
  message              text check (char_length(message) <= 1000),
  email_domain_matches boolean not null,
  source               text not null default 'web' check (source in
    ('web', 'app', 'email')),
  status               text not null default 'pending' check (status in
    ('pending', 'approved', 'rejected', 'duplicate')),
  review_note          text,
  reviewed_by          uuid,
  reviewed_at          timestamptz,
  onboarded_user_id    uuid,
  created_at           timestamptz not null default now()
);

create index if not exists idx_roaster_claim_requests_status_created_at
  on service.roaster_claim_requests (status, created_at desc);

-- One open request per roaster + email; later re-requests hit 23505 in the
-- edge function and are answered as a silent duplicate.
create unique index if not exists
  uq_roaster_claim_requests_profile_email_pending
  on service.roaster_claim_requests (roaster_profile_id, email)
  where status = 'pending';

alter table service.roaster_claim_requests enable row level security;

create policy "roaster_claim_requests_read_admin"
  on service.roaster_claim_requests
  for select
  using (public.is_admin());

create policy "roaster_claim_requests_update_admin"
  on service.roaster_claim_requests
  for update
  using (public.is_admin())
  with check (public.is_admin());

create policy "roaster_claim_requests_service_role_manage"
  on service.roaster_claim_requests
  for all
  using ((select auth.role()) = 'service_role')
  with check ((select auth.role()) = 'service_role');

revoke all on service.roaster_claim_requests from anon, authenticated;
grant select, update on service.roaster_claim_requests to authenticated;
grant all on service.roaster_claim_requests to service_role;

comment on table service.roaster_claim_requests is
  'Roaster page ownership claims submitted from the website (plan 078).';
