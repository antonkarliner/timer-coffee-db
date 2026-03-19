-- Add termsandconditions column as a global fallback for localized T&C
alter table public.giftbox_offers
  add column if not exists termsandconditions text;
