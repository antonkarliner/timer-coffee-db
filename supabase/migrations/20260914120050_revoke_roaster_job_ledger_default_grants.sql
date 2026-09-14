-- Harden service.roaster_postprocess_jobs against the service-schema default
-- privileges.
--
-- 20260914120000 granted the ledger only to service_role and enabled RLS with
-- no policy for anon/authenticated. That was not sufficient: this project has
--
--   ALTER DEFAULT PRIVILEGES IN SCHEMA service GRANT ALL ON TABLES
--     TO anon, authenticated, service_role;
--
-- (visible in pg_default_acl as anon=arwdDxt/postgres), so every NEW table in
-- the service schema is created with full anon/authenticated privileges before
-- the migration's own grants run.
--
-- RLS masks most of that, but NOT all of it. Measured against production on
-- 2026-09-14, as role anon:
--
--   SELECT   -> 0 rows            (RLS holds)
--   INSERT   -> blocked by RLS    (RLS holds)
--   DELETE   -> 0 rows            (RLS holds)
--   TRUNCATE -> SUCCEEDED         <-- TRUNCATE is not subject to RLS
--
-- TRUNCATE is a table-level privilege that row-level security cannot restrain,
-- so the inherited grant let anon empty the entire job ledger. The ledger is
-- the durability guarantee for every roaster post-processing job; wiping it
-- silently discards all queued and retrying work.
--
-- This migration removes the inherited privileges explicitly and re-asserts the
-- intended ones. It is idempotent and safe to replay.

revoke all on service.roaster_postprocess_jobs from anon;
revoke all on service.roaster_postprocess_jobs from authenticated;
revoke all on service.roaster_postprocess_jobs from public;

-- The identity column's sequence inherits the same default ACL (anon=rwU).
do $$
declare
    v_seq regclass;
begin
    select pg_get_serial_sequence('service.roaster_postprocess_jobs', 'id')::regclass
      into v_seq;

    if v_seq is not null then
        execute format('revoke all on sequence %s from anon', v_seq);
        execute format('revoke all on sequence %s from authenticated', v_seq);
        execute format('revoke all on sequence %s from public', v_seq);
        execute format('grant usage, select on sequence %s to service_role', v_seq);
    end if;
end;
$$;

-- Re-assert the intended access after the revokes.
grant select, insert, update, delete on service.roaster_postprocess_jobs to service_role;

comment on table service.roaster_postprocess_jobs is
  'Durable ledger of roaster post-processing jobs (logo mirror, colour extraction, bean attachment). service_role only: anon/authenticated are explicitly revoked because the service-schema default privileges would otherwise grant them ALL, including the TRUNCATE that RLS cannot restrain.';
