-- Remove ip_address column from system_logs table to fix inet type error
-- This migration removes the IP address column that was causing
-- "invalid input syntax for type inet" errors when multiple IPs were logged

-- Remove ip_address column from system_logs table
ALTER TABLE service.system_logs DROP COLUMN IF EXISTS ip_address;

-- Add comment explaining the change
-- COMMENT ON COLUMN service.system_logs.ip_address IS 'This column was removed to fix inet type errors caused by comma-separated IP addresses in x-forwarded-for headers. IP logging has been removed from the monitoring system to prevent similar issues.';