-- Simple migration to remove ip_address column from system_logs table
-- This fixes the inet type error caused by comma-separated IP addresses

ALTER TABLE service.system_logs DROP COLUMN IF EXISTS ip_address;