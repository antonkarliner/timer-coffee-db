-- Opt-in per-stage diagnostic capture for parse-user-recipe-draft, so a live
-- test run's per-stage LLM output becomes a replayable fixture instead of
-- being spent and lost. See (timer-coffee-landing-2 repo)
-- plans/011-recipe-draft-lab-live-test-runbook.md for why this exists: a
-- prior 20-invocation live pass recorded nothing beyond
-- public.parse_user_recipe_draft_invocations' accounting columns (id,
-- user_id, invoked_at, tokens_used, openai_tokens_used, provider_used,
-- provider_model_used), so none of those runs could be replayed or turned
-- into a regression fixture.
--
-- Written only by the parse-user-recipe-draft edge function via the
-- service-role client, and only when the caller opts in with
-- capture_stages: true on the request (see parser.ts's
-- parseUserRecipeDraftRequestSchema). capture_id (this row's id) is echoed
-- back on the response so a tester can log it alongside their observations.
--
-- Never read by anon/authenticated clients directly, so this follows the
-- same RLS convention already used for the sibling AI-recipe diagnostics
-- tables service.user_recipe_verification_invocations and
-- service.user_recipe_verification_diagnostics (see
-- 20260514120000_enable_rls_verification_tables.sql): RLS enabled with no
-- policies at all. service_role bypasses RLS automatically, and — unlike
-- service.recipe_draft_lab_access, which adds a belt-and-suspenders
-- explicit revoke/grant/policy — no grant is ever made to anon or
-- authenticated on this table, so access is deny-all except for the
-- service role, matching the verification tables' precedent rather than
-- the access-allowlist table's more defensive one.
create table service.parse_user_recipe_draft_captures (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  captured_at timestamptz not null default now(),
  request_text text not null,
  request_mode text not null,
  -- Matches public.brewing_methods.brewing_method_id's column type
  -- (character varying — see 20240422080312_remote_schema.sql). Not a
  -- foreign key: the request may omit this entirely (auto-detect) or send
  -- a hint the resolver later discards, and this column exists to record
  -- what was actually asked for, not to enforce referential integrity.
  request_brewing_method_id character varying,
  request_source_language_hint text,
  provider_used text,
  provider_model_used text,
  provider_trail jsonb,
  stage_outputs jsonb not null,
  response jsonb not null
);

create index parse_user_recipe_draft_captures_captured_at_idx
  on service.parse_user_recipe_draft_captures (captured_at desc);

alter table service.parse_user_recipe_draft_captures enable row level security;

comment on table service.parse_user_recipe_draft_captures is
  'Opt-in per-stage diagnostic capture for parse-user-recipe-draft live test runs (extraction/normalization/repair/cumulative_rewrite raw output plus the final response), making them replayable fixtures. Written only via the service role when the request sets capture_stages: true; the row id is echoed back as capture_id.';
