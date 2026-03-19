-- Enable RLS on giftbox_offers table
alter table public.giftbox_offers enable row level security;

-- Read-only policy for anonymous users when active and within validity window
create policy "giftbox_read_active" on public.giftbox_offers
  for select
  using (
    is_active
    and (valid_from is null or valid_from <= now())
    and (valid_to   is null or valid_to   >= now())
  );

-- Full access for service role
create policy "giftbox_write_service" on public.giftbox_offers
  for all
  to service_role
  using (true) with check (true);