create schema if not exists "pgmq";

create extension if not exists "pgmq" with schema "pgmq";

alter table "service"."notifications" add column "locale" text default 'en'::text;

alter table "service"."notifications" add column "platform" text;

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION service.is_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN EXISTS (
    SELECT 1 
    FROM service.admin_users 
    WHERE user_id = auth.uid()
  );
END;
$function$
;

grant select on table "public"."global_stats_daily" to "cline_mcp_readonly_role";

grant delete on table "service"."alert_thresholds" to "anon";

grant insert on table "service"."alert_thresholds" to "anon";

grant references on table "service"."alert_thresholds" to "anon";

grant select on table "service"."alert_thresholds" to "anon";

grant trigger on table "service"."alert_thresholds" to "anon";

grant truncate on table "service"."alert_thresholds" to "anon";

grant update on table "service"."alert_thresholds" to "anon";

grant delete on table "service"."alert_thresholds" to "authenticated";

grant insert on table "service"."alert_thresholds" to "authenticated";

grant references on table "service"."alert_thresholds" to "authenticated";

grant select on table "service"."alert_thresholds" to "authenticated";

grant trigger on table "service"."alert_thresholds" to "authenticated";

grant truncate on table "service"."alert_thresholds" to "authenticated";

grant update on table "service"."alert_thresholds" to "authenticated";

grant delete on table "service"."cleanup_logs" to "anon";

grant insert on table "service"."cleanup_logs" to "anon";

grant references on table "service"."cleanup_logs" to "anon";

grant select on table "service"."cleanup_logs" to "anon";

grant trigger on table "service"."cleanup_logs" to "anon";

grant truncate on table "service"."cleanup_logs" to "anon";

grant update on table "service"."cleanup_logs" to "anon";

grant delete on table "service"."cleanup_logs" to "authenticated";

grant insert on table "service"."cleanup_logs" to "authenticated";

grant references on table "service"."cleanup_logs" to "authenticated";

grant select on table "service"."cleanup_logs" to "authenticated";

grant trigger on table "service"."cleanup_logs" to "authenticated";

grant truncate on table "service"."cleanup_logs" to "authenticated";

grant update on table "service"."cleanup_logs" to "authenticated";

grant delete on table "service"."health_checks" to "anon";

grant insert on table "service"."health_checks" to "anon";

grant references on table "service"."health_checks" to "anon";

grant select on table "service"."health_checks" to "anon";

grant trigger on table "service"."health_checks" to "anon";

grant truncate on table "service"."health_checks" to "anon";

grant update on table "service"."health_checks" to "anon";

grant delete on table "service"."health_checks" to "authenticated";

grant insert on table "service"."health_checks" to "authenticated";

grant references on table "service"."health_checks" to "authenticated";

grant select on table "service"."health_checks" to "authenticated";

grant trigger on table "service"."health_checks" to "authenticated";

grant truncate on table "service"."health_checks" to "authenticated";

grant update on table "service"."health_checks" to "authenticated";

grant delete on table "service"."notification_analytics" to "anon";

grant insert on table "service"."notification_analytics" to "anon";

grant references on table "service"."notification_analytics" to "anon";

grant select on table "service"."notification_analytics" to "anon";

grant trigger on table "service"."notification_analytics" to "anon";

grant truncate on table "service"."notification_analytics" to "anon";

grant update on table "service"."notification_analytics" to "anon";

grant delete on table "service"."notification_analytics" to "authenticated";

grant insert on table "service"."notification_analytics" to "authenticated";

grant references on table "service"."notification_analytics" to "authenticated";

grant select on table "service"."notification_analytics" to "authenticated";

grant trigger on table "service"."notification_analytics" to "authenticated";

grant truncate on table "service"."notification_analytics" to "authenticated";

grant update on table "service"."notification_analytics" to "authenticated";

grant delete on table "service"."notification_delivery_logs" to "anon";

grant insert on table "service"."notification_delivery_logs" to "anon";

grant references on table "service"."notification_delivery_logs" to "anon";

grant select on table "service"."notification_delivery_logs" to "anon";

grant trigger on table "service"."notification_delivery_logs" to "anon";

grant truncate on table "service"."notification_delivery_logs" to "anon";

grant update on table "service"."notification_delivery_logs" to "anon";

grant delete on table "service"."notification_delivery_logs" to "authenticated";

grant insert on table "service"."notification_delivery_logs" to "authenticated";

grant references on table "service"."notification_delivery_logs" to "authenticated";

grant select on table "service"."notification_delivery_logs" to "authenticated";

grant trigger on table "service"."notification_delivery_logs" to "authenticated";

grant truncate on table "service"."notification_delivery_logs" to "authenticated";

grant update on table "service"."notification_delivery_logs" to "authenticated";

grant delete on table "service"."notification_templates" to "anon";

grant insert on table "service"."notification_templates" to "anon";

grant references on table "service"."notification_templates" to "anon";

grant select on table "service"."notification_templates" to "anon";

grant trigger on table "service"."notification_templates" to "anon";

grant truncate on table "service"."notification_templates" to "anon";

grant update on table "service"."notification_templates" to "anon";

grant delete on table "service"."notification_templates" to "authenticated";

grant insert on table "service"."notification_templates" to "authenticated";

grant references on table "service"."notification_templates" to "authenticated";

grant select on table "service"."notification_templates" to "authenticated";

grant trigger on table "service"."notification_templates" to "authenticated";

grant truncate on table "service"."notification_templates" to "authenticated";

grant update on table "service"."notification_templates" to "authenticated";

grant delete on table "service"."notifications" to "anon";

grant insert on table "service"."notifications" to "anon";

grant references on table "service"."notifications" to "anon";

grant select on table "service"."notifications" to "anon";

grant trigger on table "service"."notifications" to "anon";

grant truncate on table "service"."notifications" to "anon";

grant update on table "service"."notifications" to "anon";

grant delete on table "service"."notifications" to "authenticated";

grant insert on table "service"."notifications" to "authenticated";

grant references on table "service"."notifications" to "authenticated";

grant select on table "service"."notifications" to "authenticated";

grant trigger on table "service"."notifications" to "authenticated";

grant truncate on table "service"."notifications" to "authenticated";

grant update on table "service"."notifications" to "authenticated";

grant delete on table "service"."performance_metrics" to "anon";

grant insert on table "service"."performance_metrics" to "anon";

grant references on table "service"."performance_metrics" to "anon";

grant select on table "service"."performance_metrics" to "anon";

grant trigger on table "service"."performance_metrics" to "anon";

grant truncate on table "service"."performance_metrics" to "anon";

grant update on table "service"."performance_metrics" to "anon";

grant delete on table "service"."performance_metrics" to "authenticated";

grant insert on table "service"."performance_metrics" to "authenticated";

grant references on table "service"."performance_metrics" to "authenticated";

grant select on table "service"."performance_metrics" to "authenticated";

grant trigger on table "service"."performance_metrics" to "authenticated";

grant truncate on table "service"."performance_metrics" to "authenticated";

grant update on table "service"."performance_metrics" to "authenticated";

grant delete on table "service"."rate_limits" to "anon";

grant insert on table "service"."rate_limits" to "anon";

grant references on table "service"."rate_limits" to "anon";

grant select on table "service"."rate_limits" to "anon";

grant trigger on table "service"."rate_limits" to "anon";

grant truncate on table "service"."rate_limits" to "anon";

grant update on table "service"."rate_limits" to "anon";

grant delete on table "service"."rate_limits" to "authenticated";

grant insert on table "service"."rate_limits" to "authenticated";

grant references on table "service"."rate_limits" to "authenticated";

grant select on table "service"."rate_limits" to "authenticated";

grant trigger on table "service"."rate_limits" to "authenticated";

grant truncate on table "service"."rate_limits" to "authenticated";

grant update on table "service"."rate_limits" to "authenticated";

grant delete on table "service"."scheduled_notifications" to "anon";

grant insert on table "service"."scheduled_notifications" to "anon";

grant references on table "service"."scheduled_notifications" to "anon";

grant select on table "service"."scheduled_notifications" to "anon";

grant trigger on table "service"."scheduled_notifications" to "anon";

grant truncate on table "service"."scheduled_notifications" to "anon";

grant update on table "service"."scheduled_notifications" to "anon";

grant delete on table "service"."scheduled_notifications" to "authenticated";

grant insert on table "service"."scheduled_notifications" to "authenticated";

grant references on table "service"."scheduled_notifications" to "authenticated";

grant select on table "service"."scheduled_notifications" to "authenticated";

grant trigger on table "service"."scheduled_notifications" to "authenticated";

grant truncate on table "service"."scheduled_notifications" to "authenticated";

grant update on table "service"."scheduled_notifications" to "authenticated";

grant delete on table "service"."system_logs" to "anon";

grant insert on table "service"."system_logs" to "anon";

grant references on table "service"."system_logs" to "anon";

grant select on table "service"."system_logs" to "anon";

grant trigger on table "service"."system_logs" to "anon";

grant truncate on table "service"."system_logs" to "anon";

grant update on table "service"."system_logs" to "anon";

grant delete on table "service"."system_logs" to "authenticated";

grant insert on table "service"."system_logs" to "authenticated";

grant references on table "service"."system_logs" to "authenticated";

grant select on table "service"."system_logs" to "authenticated";

grant trigger on table "service"."system_logs" to "authenticated";

grant truncate on table "service"."system_logs" to "authenticated";

grant update on table "service"."system_logs" to "authenticated";

grant delete on table "service"."usage_analytics" to "anon";

grant insert on table "service"."usage_analytics" to "anon";

grant references on table "service"."usage_analytics" to "anon";

grant select on table "service"."usage_analytics" to "anon";

grant trigger on table "service"."usage_analytics" to "anon";

grant truncate on table "service"."usage_analytics" to "anon";

grant update on table "service"."usage_analytics" to "anon";

grant delete on table "service"."usage_analytics" to "authenticated";

grant insert on table "service"."usage_analytics" to "authenticated";

grant references on table "service"."usage_analytics" to "authenticated";

grant select on table "service"."usage_analytics" to "authenticated";

grant trigger on table "service"."usage_analytics" to "authenticated";

grant truncate on table "service"."usage_analytics" to "authenticated";

grant update on table "service"."usage_analytics" to "authenticated";

grant delete on table "service"."user_fcm_tokens" to "anon";

grant insert on table "service"."user_fcm_tokens" to "anon";

grant references on table "service"."user_fcm_tokens" to "anon";

grant select on table "service"."user_fcm_tokens" to "anon";

grant trigger on table "service"."user_fcm_tokens" to "anon";

grant truncate on table "service"."user_fcm_tokens" to "anon";

grant update on table "service"."user_fcm_tokens" to "anon";

grant delete on table "service"."user_fcm_tokens" to "authenticated";

grant insert on table "service"."user_fcm_tokens" to "authenticated";

grant references on table "service"."user_fcm_tokens" to "authenticated";

grant select on table "service"."user_fcm_tokens" to "authenticated";

grant trigger on table "service"."user_fcm_tokens" to "authenticated";

grant truncate on table "service"."user_fcm_tokens" to "authenticated";

grant update on table "service"."user_fcm_tokens" to "authenticated";

grant delete on table "service"."user_notification_preferences" to "anon";

grant insert on table "service"."user_notification_preferences" to "anon";

grant references on table "service"."user_notification_preferences" to "anon";

grant select on table "service"."user_notification_preferences" to "anon";

grant trigger on table "service"."user_notification_preferences" to "anon";

grant truncate on table "service"."user_notification_preferences" to "anon";

grant update on table "service"."user_notification_preferences" to "anon";

grant delete on table "service"."user_notification_preferences" to "authenticated";

grant insert on table "service"."user_notification_preferences" to "authenticated";

grant references on table "service"."user_notification_preferences" to "authenticated";

grant select on table "service"."user_notification_preferences" to "authenticated";

grant trigger on table "service"."user_notification_preferences" to "authenticated";

grant truncate on table "service"."user_notification_preferences" to "authenticated";

grant update on table "service"."user_notification_preferences" to "authenticated";


  create policy "Allow Authenticated Delete Own Profile Picture"
  on "storage"."objects"
  as permissive
  for delete
  to authenticated
using (((bucket_id = 'user-profile-pictures'::text) AND ((auth.uid())::text = name)));



  create policy "Allow Authenticated Insert Own Profile Picture"
  on "storage"."objects"
  as permissive
  for insert
  to authenticated
with check (((bucket_id = 'user-profile-pictures'::text) AND ((auth.uid())::text = name)));



  create policy "Allow Authenticated Update Own Profile Picture"
  on "storage"."objects"
  as permissive
  for update
  to authenticated
using (((bucket_id = 'user-profile-pictures'::text) AND ((auth.uid())::text = name)))
with check (((bucket_id = 'user-profile-pictures'::text) AND ((auth.uid())::text = name)));



  create policy "Allow Public Read Access"
  on "storage"."objects"
  as permissive
  for select
  to public
using ((bucket_id = 'user-profile-pictures'::text));



  create policy "coffee_labels_upload_all 1hbusyo_0"
  on "storage"."objects"
  as permissive
  for insert
  to public
with check ((bucket_id = 'coffee-labels'::text));



  create policy "coffee_labels_upload_all 1hbusyo_1"
  on "storage"."objects"
  as permissive
  for select
  to public
using ((bucket_id = 'coffee-labels'::text));



