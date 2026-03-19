
SET default_transaction_read_only = off;

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;

--CREATE ROLE "supabase_realtime_admin";
-- ALTER ROLE "supabase_realtime_admin" WITH NOINHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOBYPASSRLS;

-- Create MCP readonly role if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'cline_mcp_readonly_role') THEN
        CREATE ROLE "cline_mcp_readonly_role" WITH NOINHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOBYPASSRLS;
    END IF;
END
$$;

ALTER ROLE "anon" SET "statement_timeout" TO '3s';

ALTER ROLE "authenticated" SET "statement_timeout" TO '8s';

ALTER ROLE "authenticator" SET "statement_timeout" TO '8s';

RESET ALL;
