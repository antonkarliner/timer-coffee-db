-- Ensure giftbox offer slugs are unique when present
create unique index if not exists giftbox_offers_slug_unique
on public.giftbox_offers (slug)
where slug is not null;

-- Ensure service schema is available
create schema if not exists service;

-- Click log table for giftbox offers
create table if not exists service.giftbox_offer_clicks (
  id bigserial primary key,
  offer_id uuid not null references public.giftbox_offers(id) on delete cascade,
  slug text not null,
  created_at timestamptz not null default now(),

  src text null,
  platform text null,
  app_version text null,
  locale text null,
  install_id text null,
  user_agent text null
);

create index if not exists giftbox_offer_clicks_offer_time_idx
  on service.giftbox_offer_clicks (offer_id, created_at desc);

create index if not exists giftbox_offer_clicks_slug_time_idx
  on service.giftbox_offer_clicks (slug, created_at desc);

create index if not exists giftbox_offer_clicks_install_time_idx
  on service.giftbox_offer_clicks (install_id, created_at desc);
