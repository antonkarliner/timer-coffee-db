-- Add country_code to global_stats to track per-country usage statistics
alter table "public"."global_stats" add column "country_code" character(2);
