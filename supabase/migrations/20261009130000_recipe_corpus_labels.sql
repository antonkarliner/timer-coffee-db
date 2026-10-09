-- Plan 080 Phase 2 / D1: private labels for the recipe step corpus.
--
-- The operator hand-labels ~400 amounts found in the AI-review diagnostics
-- (service.user_recipe_verification_diagnostics) to measure the app's amount
-- converter. A label points at a span by position only and never stores text,
-- so it carries no user content and is deleted with the diagnostics row it
-- refers to (on delete cascade). The 2027-04-09 cron job
-- delete-verification-diagnostics (20261009120100) therefore clears labels
-- too, and plan 080 Phase 5 drops this table.
--
-- Access: service_role only. New tables and sequences in `service` inherit
-- default privileges that grant anon/authenticated arwd (tables) and rwU
-- (sequences) -- checked in pg_default_acl on 2026-10-09 -- so both objects
-- are revoked from them by name. RLS is on with no policies; service_role
-- bypasses it. The unique constraint leads with diagnostics_id, which also
-- serves the cascade lookup, so no other index is added.

create table service.recipe_corpus_labels (
    id bigint generated always as identity primary key,
    diagnostics_id bigint not null
        references service.user_recipe_verification_diagnostics(id) on delete cascade,
    step_index integer not null check (step_index >= 0),
    char_start integer not null check (char_start >= 0),
    char_end integer not null,
    label text not null check (
        label in ('coffee', 'water', 'fixed', 'cumulative_target_water', 'not_an_amount')
    ),
    labeled_at timestamptz not null default now(),
    check (char_end > char_start),
    unique (diagnostics_id, step_index, char_start, char_end)
);

comment on table service.recipe_corpus_labels is
    'Plan 080 golden-set labels for amounts in AI-review diagnostics. Positions only: there is no text column by design. Rows cascade-delete with their diagnostics row (the 2027-04-09 cron job delete-verification-diagnostics clears them too); plan 080 Phase 5 drops this table.';
comment on column service.recipe_corpus_labels.step_index is
    'Zero-based index into source_steps of the referenced diagnostics row.';
comment on column service.recipe_corpus_labels.char_start is
    'Start of the labelled span: UTF-16 code-unit offset into source_steps[step_index].description, the step text exactly as the user typed it.';
comment on column service.recipe_corpus_labels.char_end is
    'End of the labelled span, exclusive: UTF-16 code-unit offset into source_steps[step_index].description.';

alter table service.recipe_corpus_labels enable row level security;

revoke all on table service.recipe_corpus_labels from anon;
revoke all on table service.recipe_corpus_labels from authenticated;
revoke all on sequence service.recipe_corpus_labels_id_seq from anon;
revoke all on sequence service.recipe_corpus_labels_id_seq from authenticated;

grant select, insert, update, delete on table service.recipe_corpus_labels to service_role;
grant usage, select on sequence service.recipe_corpus_labels_id_seq to service_role;
