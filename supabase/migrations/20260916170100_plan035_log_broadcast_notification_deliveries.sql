-- Plan 035 §4.2: let broadcast notification deliveries be logged at all
--
-- `service.notification_delivery_logs.user_id` is NOT NULL. Broadcast sends have no
-- single recipient, so `send-fcm-notification` passes `parsed.userId` = null to
-- `service.log_delivery_results_secure`, the insert raises a not-null violation, and
-- the row is lost. supabase-js resolves an RPC failure as `{ error }` rather than
-- rejecting, so the caller's `Promise.all(...).catch(...)` never fired and nothing
-- was ever reported. (The caller is fixed separately, in the edge function.)
--
-- This was misread as "FCM delivery stopped in June". It did not. Notifications kept
-- being created the whole time; what changed is that the traffic became almost
-- entirely broadcast. Measured on production 2026-09-16, delivery-log rows track
-- targeted (non-null user_id) notifications exactly, and broadcasts contribute none:
--
--     month     notifications   of which broadcast   targeted   delivery_logs
--     2025-12              46                   14         32              31
--     2026-01              30                   26          4               4
--     2026-03              65                   65          0               0
--     2026-04               7                    7          0               0
--     2026-05              14                   14          0               0
--     2026-06              18                   16          2               2
--     2026-07              14                   14          0               0
--     2026-08              21                   21          0               0
--     2026-09               7                    7          0               0
--
-- All 37 existing rows have a non-null user_id. Every one of the 114 broadcasts since
-- March logged nothing.
--
-- Fix, in two parts:
--
-- 1. Resolve the recipient from the token when the caller cannot supply one. A
--    delivery log row is per-token, and every token row carries its owner, so a
--    broadcast's rows can name the actual recipient. This matters beyond tidiness:
--    the "User view own delivery logs" RLS policy is `auth.uid() = user_id`, so a
--    row with a resolved user_id stays visible to the user it belongs to, which a
--    null-filled one never would.
--
-- 2. Drop the NOT NULL. Resolution can still come up empty — `token_id` is nullable
--    and its FK is ON DELETE SET NULL, so a token deleted between send and log leaves
--    nothing to resolve from. In that case recording the delivery with a null user_id
--    is better than discarding it and raising.
--
-- The column keeps its FK to auth.users(id) ON DELETE CASCADE, which permits NULL.

alter table service.notification_delivery_logs
    alter column user_id drop not null;

-- Unchanged from the existing definition apart from the recipient resolution:
-- same signature (including the three trailing parameter defaults, which
-- CREATE OR REPLACE may not drop), SECURITY DEFINER, owner, search_path and
-- token hashing.
-- CREATE OR REPLACE preserves the ACL, which is {postgres, service_role} after
-- plan 033 and must stay that way.
create or replace function service.log_delivery_results_secure(
    p_notification_id uuid,
    p_user_id uuid,
    p_token_id uuid,
    p_token text,
    p_device_type text,
    p_status text,
    p_error_code text default null::text,
    p_error_message text default null::text,
    p_fcm_message_id text default null::text
)
returns void
language plpgsql
security definer
set search_path to 'service', 'public', 'extensions', 'pg_catalog'
as $function$
declare
    v_user_id uuid;
begin
    -- Broadcasts pass p_user_id = null because they have no single recipient.
    -- Fall back to the token's owner so the row still names a real user.
    v_user_id := coalesce(
        p_user_id,
        (select t.user_id from service.user_fcm_tokens t where t.id = p_token_id)
    );

    insert into service.notification_delivery_logs (
        notification_id,
        user_id,
        token_id,
        token,
        token_hash,
        device_type,
        status,
        error_code,
        error_message,
        fcm_message_id
    ) values (
        p_notification_id,
        v_user_id,
        p_token_id,
        p_token,
        service.hash_fcm_token(p_token),
        p_device_type,
        p_status,
        p_error_code,
        p_error_message,
        p_fcm_message_id
    );
end;
$function$;
