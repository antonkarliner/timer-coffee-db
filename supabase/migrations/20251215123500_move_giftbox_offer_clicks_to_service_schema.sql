-- Move giftbox_offer_clicks from public to service schema (if needed)

create schema if not exists service;

do $$
begin
  if to_regclass('public.giftbox_offer_clicks') is not null
     and to_regclass('service.giftbox_offer_clicks') is null then
    alter table public.giftbox_offer_clicks set schema service;
  end if;
end$$;
