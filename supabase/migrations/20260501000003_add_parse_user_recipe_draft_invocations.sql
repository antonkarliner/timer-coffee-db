create table public.parse_user_recipe_draft_invocations (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  invoked_at timestamptz not null default now(),
  tokens_used bigint not null default 0,
  openai_tokens_used bigint not null default 0,
  provider_used text not null,
  provider_model_used text not null
);

create index on public.parse_user_recipe_draft_invocations (invoked_at);

alter table public.parse_user_recipe_draft_invocations enable row level security;

create policy "users_read_own_invocations"
  on public.parse_user_recipe_draft_invocations
  for select
  using (auth.uid() = user_id);
