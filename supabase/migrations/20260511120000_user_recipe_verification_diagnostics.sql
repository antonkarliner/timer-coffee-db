create table service.user_recipe_verification_invocations (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  invoked_at timestamptz not null default now(),
  tokens_used bigint not null default 0,
  openai_tokens_used bigint not null default 0,
  provider_used text not null,
  provider_model_used text not null
);

create index user_recipe_verification_invocations_user_time_idx
  on service.user_recipe_verification_invocations (user_id, invoked_at desc);

create index user_recipe_verification_invocations_time_idx
  on service.user_recipe_verification_invocations (invoked_at desc);

create table service.user_recipe_verification_diagnostics (
  id bigint generated always as identity primary key,
  invocation_id bigint references service.user_recipe_verification_invocations(id)
    on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  app_locale text not null,
  source_language_hint text,
  recipe jsonb not null,
  source_steps jsonb not null,
  corrected_steps jsonb not null,
  validation_issues jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  provider_used text not null,
  provider_model_used text not null,
  tokens_used bigint not null default 0,
  openai_tokens_used bigint not null default 0
);

create index user_recipe_verification_diagnostics_user_time_idx
  on service.user_recipe_verification_diagnostics (user_id, created_at desc);

comment on table service.user_recipe_verification_invocations is
  'Private operational metadata for signed-in user recipe AI verification rate limits and usage accounting.';

comment on table service.user_recipe_verification_diagnostics is
  'Private consent-gated diagnostics for AI-assisted user recipe verification. Not exposed to public clients.';
