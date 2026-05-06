-- Seed recipe_import_events from the historical user_recipes rows that
-- already encode (source recipe, importer) pairs via import_id and vendor_id.
-- Idempotent: ON CONFLICT skips any pair already present.

insert into public.recipe_import_events (import_id, importer_user_id, imported_at)
select
  ur.import_id,
  substring(ur.vendor_id from 5)::uuid as importer_user_id,
  coalesce(ur.last_modified, now()) as imported_at
from public.user_recipes ur
where ur.is_imported = true
  and ur.import_id is not null
  and ur.vendor_id like 'usr-%'
  and substring(ur.vendor_id from 5) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
on conflict (import_id, importer_user_id) do nothing;
