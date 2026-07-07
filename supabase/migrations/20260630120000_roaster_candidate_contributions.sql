-- User-contributed roaster enrichment (plan 011, Phase 1).
--
-- App users who log beans for a roaster that is NOT yet in public.coffee_roasters
-- can submit that roaster's official website (and optionally Instagram / city /
-- country) to expedite the candidate-enrichment review. Submissions attach to the
-- pending candidate cluster (service.roaster_candidate_clusters) and trigger a
-- fresh enrichment pass that uses the user-supplied website as a high-confidence
-- identity lead.
--
-- A user website is the strongest signal available: it collapses the hardest step
-- of enrichment (identity resolution). Writes go through the
-- submit-roaster-contribution edge function (service role); the human review gate
-- is unchanged, so a bad URL only degrades to a low-confidence card.

--------------------------------------------------------------------------------
-- 1) Table: one contribution per (cluster, submitter)
--------------------------------------------------------------------------------

create table if not exists service.roaster_candidate_contributions (
  id              bigserial primary key,
  cluster_id      uuid not null references service.roaster_candidate_clusters(id) on delete cascade,
  normalized_name text not null,
  website_url     text not null,
  website_domain  text,
  instagram_url   text,
  city            text,
  country         text,
  submitted_by    uuid,                          -- auth.uid() of the submitter (incl. anonymous users)
  source          text not null default 'app_nudge',
  status          text not null default 'new',   -- new | used | rejected
  signals         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (cluster_id, submitted_by)
);

create index if not exists idx_roaster_candidate_contributions_cluster_id
  on service.roaster_candidate_contributions (cluster_id);

create index if not exists idx_roaster_candidate_contributions_created_at
  on service.roaster_candidate_contributions (created_at desc);

--------------------------------------------------------------------------------
-- 2) RLS: locked to service_role writes + admin reads
--    (mirrors service.roaster_enrichment_* tables; no anon/authenticated grants:
--    the service schema is exempt from the public-schema grant requirement, and
--    all writes go through the submit-roaster-contribution edge function).
--------------------------------------------------------------------------------

alter table service.roaster_candidate_contributions enable row level security;

drop policy if exists "roaster_candidate_contributions_read_admin"
  on service.roaster_candidate_contributions;
create policy "roaster_candidate_contributions_read_admin"
  on service.roaster_candidate_contributions
  for select
  using (public.is_admin());

drop policy if exists "roaster_candidate_contributions_service_role_manage"
  on service.roaster_candidate_contributions;
create policy "roaster_candidate_contributions_service_role_manage"
  on service.roaster_candidate_contributions
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

--------------------------------------------------------------------------------
-- 3) Detection RPC: is a free-text roaster already a known roaster, or a pending
--    candidate cluster? The app calls this to decide whether to prompt the user
--    for a contribution.
--      matched_roaster_id  -> non-null: roaster already exists, do NOT prompt
--      cluster_id + status -> a pending cluster means "eligible to contribute"
--------------------------------------------------------------------------------

create or replace function public.roaster_contribution_target(p_roaster text)
returns json
language sql
stable
security definer
set search_path = public, service, extensions, pg_catalog
as $function$
  with norm as (
    select service.normalize_roaster_name(p_roaster) as n
  ),
  cluster as (
    select c.id, c.status, c.normalized_name
    from service.roaster_candidate_clusters c, norm
    where norm.n is not null
      and c.normalized_name = norm.n
    limit 1
  )
  select json_build_object(
    'matched_roaster_id', public.resolve_coffee_roaster_id(p_roaster),
    'cluster_id',         (select id from cluster),
    'cluster_status',     (select status from cluster),
    'normalized_name',    (select normalized_name from cluster)
  );
$function$;

grant execute on function public.roaster_contribution_target(text)
  to anon, authenticated, service_role;
