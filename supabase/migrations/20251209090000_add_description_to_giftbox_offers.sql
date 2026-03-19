-- Add optional description column to giftbox_offers
alter table public.giftbox_offers
  add column if not exists description text;

-- No data backfill needed; NULL is acceptable for existing rows.
