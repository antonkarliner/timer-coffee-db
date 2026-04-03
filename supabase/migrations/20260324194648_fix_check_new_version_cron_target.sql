-- Fix the check-new-version cron job to call check_new_version_cron() which reads
-- the project URL from Vault at runtime rather than using a hardcoded URL.

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.check_new_version_cron()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  project_url text := (
    select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url'
  );
  service_key text := (
    select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
  );
begin
  if project_url is null then
    raise exception 'Vault secret supabase_url is not set.';
  end if;

  if service_key is null then
    raise exception 'Vault secret service_role_key is not set.';
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/check-new-version',
    body := jsonb_build_object('trigger', 'pg_cron', 'timestamp', timezone('utc', now())),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    timeout_milliseconds := 30000
  );
end;
$function$;

-- Replace any existing check-new-version cron entry with the correct target function
SELECT cron.unschedule('check-new-version-every-30-minutes');
SELECT cron.schedule(
  'check-new-version-every-30-minutes',
  '*/30 * * * *',
  'select public.check_new_version_cron();'
);
