-- Create giftbox_offers table
create table public.giftbox_offers (
  id uuid primary key default gen_random_uuid(),
  partner_name text not null,
  description text,
  website_url text,
  image_url text,
  festive_color text,
  promo_code text,
  discount_text text,
  discount_min_percent numeric,
  discount_max_percent numeric,
  regions text[] default '{"WW"}',
  localizations jsonb not null default '{}',
  valid_from timestamptz,
  valid_to timestamptz,
  priority int default 0,
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);

-- Create indexes for performance
create index giftbox_active_idx on public.giftbox_offers (is_active, priority, valid_to);
create index giftbox_regions_gin on public.giftbox_offers using gin (regions);
