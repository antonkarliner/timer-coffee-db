-- plan 034 section 2.2: Jev roaster-link shadow mode evaluation table.
--
-- parse-coffee-label writes ONE row here per roaster-link decision, whatever
-- the outcome (linked / abstained / below_threshold / no_candidates /
-- jev_failed / error), so fallback rates and threshold behaviour are
-- measurable before the feature is ever enabled. true_roaster_id and
-- labelled_at are filled later by a human labeller.
--
-- Two feature flags are seeded, both disabled, so nothing user-visible
-- changes until an operator flips one:
--   jev_roaster_link_shadow -> shadow mode (log only, response unchanged)
--   jev_roaster_link        -> enforce mode (attach result.roasterLink; also logs)

create table service.jev_eval_roaster_link (
  id                 bigint generated always as identity primary key,
  created_at         timestamptz not null default now(),
  correlation_id     text,
  mode               text not null check (mode in ('shadow', 'enforce')),
  outcome            text not null check (outcome in (
                       'linked',
                       'abstained',
                       'below_threshold',
                       'no_candidates',
                       'jev_failed',
                       'error'
                     )),
  raw_roaster        text not null,
  roaster_brand_name text,
  -- Exactly what was sent to Jev; null when Jev never ran.
  jev_state          jsonb,
  candidate_ids      bigint[], -- coffee_roasters.id is BIGINT, not int
  trigram_top_id     bigint,
  trigram_top_conf   double precision,
  jev_choice         text,
  jev_p              double precision,
  jev_confidence     double precision,
  jev_probabilities  jsonb,
  linked_roaster_id  bigint,
  latency_ms         integer,
  true_roaster_id    bigint,
  labelled_at        timestamptz
);

create index jev_eval_roaster_link_created_at_idx
  on service.jev_eval_roaster_link (created_at);

-- RLS with NO policies: service_role bypasses RLS; nobody else should ever
-- see these evaluation rows.
alter table service.jev_eval_roaster_link enable row level security;

-- This project's default privileges grant every NEW service-schema table FULL
-- access (arwdDxt) to anon and authenticated (visible in pg_default_acl), and
-- RLS cannot restrain TRUNCATE. Revoke by name — revoking from the PUBLIC
-- pseudo-role does not touch grants to named roles — then assert the intended
-- end state for service_role only.
revoke all on table service.jev_eval_roaster_link from anon;
revoke all on table service.jev_eval_roaster_link from authenticated;
revoke all on table service.jev_eval_roaster_link from public;
grant select, insert, update on table service.jev_eval_roaster_link to service_role;

-- The identity sequence inherits the same default ACL; re-assert it too.
do $$
declare
    v_seq regclass;
begin
    select pg_get_serial_sequence('service.jev_eval_roaster_link', 'id')::regclass
      into v_seq;

    if v_seq is not null then
        execute format('revoke all on sequence %s from anon', v_seq);
        execute format('revoke all on sequence %s from authenticated', v_seq);
        execute format('revoke all on sequence %s from public', v_seq);
        execute format('grant usage, select on sequence %s to service_role', v_seq);
    end if;
end;
$$;

-- Seed the flags disabled, idempotently: never overwrite an operator's
-- manual flip on an existing environment.
insert into service.feature_flags (key, enabled, description)
values
  (
    'jev_roaster_link_shadow',
    false,
    'parse-coffee-label: run Jev roaster linking in shadow mode - decisions are logged to service.jev_eval_roaster_link and the HTTP response is unchanged'
  ),
  (
    'jev_roaster_link',
    false,
    'parse-coffee-label: enforce Jev roaster linking - attach result.roasterLink to the response (decisions are also logged). Overrides jev_roaster_link_shadow'
  )
on conflict (key) do nothing;
