-- Roaster candidate enrichment schema updates

alter table service.new_roaster_candidates
  add column cluster_id uuid null,
  add column priority_score numeric null,
  add column last_enrichment_at timestamptz null;

alter table public.coffee_roasters
  add column roaster_website_url text null;

create table service.roaster_candidate_clusters (
  id uuid primary key default gen_random_uuid(),
  normalized_name text not null,
  display_name text null,
  sample_names jsonb not null default '[]',
  candidate_count int not null default 0,
  occurrences int not null default 0,
  status text not null default 'pending',
  best_match_roaster_id bigint null,
  confidence numeric null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table service.roaster_enrichment_results (
  id uuid primary key default gen_random_uuid(),
  cluster_id uuid not null references service.roaster_candidate_clusters(id),
  status text not null default 'pending',
  proposed jsonb not null,
  sources jsonb not null default '[]',
  signals jsonb not null default '{}',
  confidence numeric not null default 0,
  error text null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table service.roaster_enrichment_jobs (
  id bigserial primary key,
  cluster_id uuid not null references service.roaster_candidate_clusters(id),
  state text not null default 'queued',
  attempts int not null default 0,
  run_after timestamptz not null default now(),
  locked_at timestamptz null,
  locked_by text null,
  last_error text null,
  created_at timestamptz not null default now()
);

create index on service.roaster_enrichment_jobs (state, run_after);

alter table service.roaster_candidate_clusters enable row level security;
alter table service.roaster_enrichment_results enable row level security;
alter table service.roaster_enrichment_jobs enable row level security;
