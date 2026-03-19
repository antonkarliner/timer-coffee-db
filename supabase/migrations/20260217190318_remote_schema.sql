-- Note: Storage triggers under the managed "storage" schema are owned by
-- Supabase service roles such as "supabase_storage_admin", not by the role
-- that applies CLI migrations. Keeping these statements causes `db push` /
-- `db reset` to fail with ownership errors such as:
--   must be owner of relation prefixes
--
-- This remote schema diff only reflected platform-managed trigger churn, so it
-- is intentionally left as a no-op in migration history.

