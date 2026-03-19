-- Add optional slug column to giftbox_offers
alter table public.giftbox_offers
  add column if not exists slug text;

-- No data backfill needed; NULL is acceptable for existing rows.
