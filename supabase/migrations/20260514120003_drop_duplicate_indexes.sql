-- Drop duplicate unique index on vendors — the FK (public_recipes_vendor_id_fkey)
-- already references vendors_pkey, so this index is truly redundant.
--
-- NOT dropping supported_locales_locale_key or brewing_methods_brewing_method_id_key:
-- FK constraints on those tables bind to the _key unique constraint (not the PK),
-- so those indexes must remain until the FKs are re-created pointing to the PK.

alter table public.vendors drop constraint if exists vendors_vendor_id_key;
