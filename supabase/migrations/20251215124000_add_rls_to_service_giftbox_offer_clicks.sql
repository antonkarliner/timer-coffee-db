-- RLS policies for service.giftbox_offer_clicks (admin-readable)

alter table service.giftbox_offer_clicks enable row level security;

create policy "giftbox_offer_clicks_read_admin"
  on service.giftbox_offer_clicks
  for select
  using (public.is_admin());

create policy "giftbox_offer_clicks_service_role_manage"
  on service.giftbox_offer_clicks
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- Required privileges (RLS still applies)
grant usage on schema service to authenticated;
grant usage on schema service to service_role;
grant select on table service.giftbox_offer_clicks to authenticated;
grant all on table service.giftbox_offer_clicks to service_role;

-- Ensure service_role can generate bigserial IDs
do $$
begin
  if to_regclass('service.giftbox_offer_clicks_id_seq') is not null then
    grant usage, select on sequence service.giftbox_offer_clicks_id_seq to service_role;
  elsif to_regclass('public.giftbox_offer_clicks_id_seq') is not null then
    grant usage, select on sequence public.giftbox_offer_clicks_id_seq to service_role;
  end if;
end$$;
