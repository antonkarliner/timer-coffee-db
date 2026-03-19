-- Phase 1: Core service schema objects for Supabase FCM migration
-- Generated on 2025-11-09

-- Ensure service schema exists
CREATE SCHEMA IF NOT EXISTS service AUTHORIZATION postgres;

-- Basic access so authenticated contexts can reference the schema (RLS still restricts rows)
GRANT USAGE ON SCHEMA service TO authenticated;
GRANT USAGE ON SCHEMA service TO service_role;

-- Helper function for updated_at bookkeeping
CREATE OR REPLACE FUNCTION service.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = timezone('utc', now());
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION service.set_updated_at() IS 'Ensures updated_at columns are refreshed using UTC timestamps.';

-- Admin helper based on service.admin_users table and service role context
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = service, public, auth
AS $$
BEGIN
  IF auth.role() = 'service_role' THEN
    RETURN TRUE;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM service.admin_users au
    WHERE au.user_id = auth.uid()
      AND COALESCE(au.role, 'admin') IN ('admin', 'super_admin')
  );
END;
$$;

COMMENT ON FUNCTION public.is_admin() IS 'Returns true when current JWT belongs to service role or a user recorded in service.admin_users with admin privileges.';

-- =====================================================================
-- service.user_fcm_tokens
-- =====================================================================
CREATE TABLE IF NOT EXISTS service.user_fcm_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    token text NOT NULL UNIQUE,
    device_type text NOT NULL CHECK (device_type IN ('android', 'ios', 'web')),
    device_model text,
    app_version text,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    last_used_at timestamptz,
    ip_address inet,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_service_user_fcm_tokens_user_id ON service.user_fcm_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_service_user_fcm_tokens_device_type ON service.user_fcm_tokens(device_type);
CREATE INDEX IF NOT EXISTS idx_service_user_fcm_tokens_is_active ON service.user_fcm_tokens(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_service_user_fcm_tokens_last_used_at ON service.user_fcm_tokens(last_used_at DESC);

ALTER TABLE service.user_fcm_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own tokens" ON service.user_fcm_tokens
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can manage own tokens" ON service.user_fcm_tokens
    FOR ALL TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admin manage all tokens" ON service.user_fcm_tokens
    FOR ALL USING (public.is_admin());

CREATE POLICY "Service role manage tokens" ON service.user_fcm_tokens
    FOR ALL USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

CREATE TRIGGER trg_user_fcm_tokens_set_updated_at
    BEFORE UPDATE ON service.user_fcm_tokens
    FOR EACH ROW EXECUTE FUNCTION service.set_updated_at();

-- =====================================================================
-- service.notification_templates
-- =====================================================================
CREATE TABLE IF NOT EXISTS service.notification_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL UNIQUE,
    title_template text NOT NULL,
    body_template text NOT NULL,
    data_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
    category text NOT NULL DEFAULT 'general',
    is_active boolean NOT NULL DEFAULT true,
    created_by uuid REFERENCES auth.users(id),
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    usage_count integer NOT NULL DEFAULT 0,
    success_rate numeric(5,2) NOT NULL DEFAULT 0.00,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_service_notification_templates_name ON service.notification_templates(name);
CREATE INDEX IF NOT EXISTS idx_service_notification_templates_category ON service.notification_templates(category);
CREATE INDEX IF NOT EXISTS idx_service_notification_templates_is_active ON service.notification_templates(is_active) WHERE is_active = true;

ALTER TABLE service.notification_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin manage templates" ON service.notification_templates
    FOR ALL USING (public.is_admin());

CREATE POLICY "Users view active templates" ON service.notification_templates
    FOR SELECT TO authenticated
    USING (is_active = true);

CREATE POLICY "Service role manage templates" ON service.notification_templates
    FOR ALL USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

CREATE TRIGGER trg_notification_templates_set_updated_at
    BEFORE UPDATE ON service.notification_templates
    FOR EACH ROW EXECUTE FUNCTION service.set_updated_at();

-- =====================================================================
-- service.notifications
-- =====================================================================
CREATE TABLE IF NOT EXISTS service.notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id),
    template_id uuid REFERENCES service.notification_templates(id),
    title text NOT NULL,
    body text NOT NULL,
    data jsonb NOT NULL DEFAULT '{}'::jsonb,
    priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
    category text DEFAULT 'general',
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'cancelled')),
    sent_at timestamptz,
    delivered_at timestamptz,
    failed_at timestamptz,
    failure_reason text,
    fcm_message_id text,
    tokens_targeted integer NOT NULL DEFAULT 0,
    tokens_successful integer NOT NULL DEFAULT 0,
    tokens_failed integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_service_notifications_user_id ON service.notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_service_notifications_status ON service.notifications(status);
CREATE INDEX IF NOT EXISTS idx_service_notifications_created_at ON service.notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_notifications_sent_at ON service.notifications(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_notifications_template_id ON service.notifications(template_id);
CREATE INDEX IF NOT EXISTS idx_service_notifications_fcm_message_id ON service.notifications(fcm_message_id);
CREATE INDEX IF NOT EXISTS idx_service_notifications_user_status ON service.notifications(user_id, status);
CREATE INDEX IF NOT EXISTS idx_service_notifications_status_created ON service.notifications(status, created_at DESC);

ALTER TABLE service.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own notifications" ON service.notifications
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Admin view notifications" ON service.notifications
    FOR SELECT USING (public.is_admin());

CREATE POLICY "Service role insert notifications" ON service.notifications
    FOR INSERT WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role update notifications" ON service.notifications
    FOR UPDATE USING (auth.role() = 'service_role');

CREATE POLICY "Service role delete notifications" ON service.notifications
    FOR DELETE USING (auth.role() = 'service_role');

CREATE TRIGGER trg_notifications_set_updated_at
    BEFORE UPDATE ON service.notifications
    FOR EACH ROW EXECUTE FUNCTION service.set_updated_at();

-- =====================================================================
-- service.notification_analytics
-- =====================================================================
CREATE TABLE IF NOT EXISTS service.notification_analytics (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    date date NOT NULL,
    hour integer NOT NULL CHECK (hour >= 0 AND hour <= 23),
    template_id uuid REFERENCES service.notification_templates(id),
    device_type text CHECK (device_type IN ('android', 'ios', 'web', 'unknown')),
    total_sent integer NOT NULL DEFAULT 0,
    total_delivered integer NOT NULL DEFAULT 0,
    total_failed integer NOT NULL DEFAULT 0,
    total_pending integer NOT NULL DEFAULT 0,
    avg_delivery_time_ms integer,
    delivery_rate numeric(5,2) NOT NULL DEFAULT 0.00,
    failure_rate numeric(5,2) NOT NULL DEFAULT 0.00,
    error_invalid_token integer NOT NULL DEFAULT 0,
    error_quota_exceeded integer NOT NULL DEFAULT 0,
    error_server_error integer NOT NULL DEFAULT 0,
    error_timeout integer NOT NULL DEFAULT 0,
    error_unknown integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    UNIQUE (date, hour, template_id, device_type)
);

CREATE INDEX IF NOT EXISTS idx_service_notification_analytics_date ON service.notification_analytics(date);
CREATE INDEX IF NOT EXISTS idx_service_notification_analytics_date_hour ON service.notification_analytics(date, hour);
CREATE INDEX IF NOT EXISTS idx_service_notification_analytics_template ON service.notification_analytics(template_id);
CREATE INDEX IF NOT EXISTS idx_service_notification_analytics_device_type ON service.notification_analytics(device_type);
CREATE INDEX IF NOT EXISTS idx_service_notification_analytics_delivery_rate ON service.notification_analytics(delivery_rate);

ALTER TABLE service.notification_analytics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin view analytics" ON service.notification_analytics
    FOR SELECT USING (public.is_admin());

CREATE POLICY "Service role manage analytics" ON service.notification_analytics
    FOR ALL USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

CREATE TRIGGER trg_notification_analytics_set_updated_at
    BEFORE UPDATE ON service.notification_analytics
    FOR EACH ROW EXECUTE FUNCTION service.set_updated_at();

-- =====================================================================
-- service.cleanup_logs
-- =====================================================================
CREATE TABLE IF NOT EXISTS service.cleanup_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    action text NOT NULL,
    records_affected integer NOT NULL DEFAULT 0,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

ALTER TABLE service.cleanup_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin view cleanup logs" ON service.cleanup_logs
    FOR SELECT USING (public.is_admin());

CREATE POLICY "Service role insert cleanup logs" ON service.cleanup_logs
    FOR INSERT WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role manage cleanup logs" ON service.cleanup_logs
    FOR ALL USING (auth.role() = 'service_role');

-- =====================================================================
-- Functions for maintenance and analytics
-- =====================================================================
CREATE OR REPLACE FUNCTION service.cleanup_invalid_tokens(p_max_age_days integer DEFAULT 90)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = service, public, auth
AS $$
DECLARE
    deleted_count integer := 0;
    cutoff timestamptz;
BEGIN
    cutoff := timezone('utc', now()) - make_interval(days => COALESCE(p_max_age_days, 90));

    DELETE FROM service.user_fcm_tokens
    WHERE (last_used_at IS NOT NULL AND last_used_at < cutoff)
       OR is_active = false;

    GET DIAGNOSTICS deleted_count = ROW_COUNT;

    INSERT INTO service.cleanup_logs (action, records_affected, details)
    VALUES ('token_cleanup', deleted_count, jsonb_build_object('cutoff', cutoff, 'max_age_days', p_max_age_days));

    RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION service.cleanup_invalid_tokens(integer) IS 'Removes inactive or stale FCM tokens and records the cleanup summary.';

CREATE OR REPLACE FUNCTION service.aggregate_notification_analytics(p_date date, p_hour integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = service, public, auth
AS $$
DECLARE
    start_window timestamptz;
    end_window timestamptz;
BEGIN
    IF p_hour < 0 OR p_hour > 23 THEN
        RAISE EXCEPTION 'Hour value % is outside 0-23', p_hour;
    END IF;

    start_window := make_timestamptz(
        EXTRACT(year FROM p_date)::int,
        EXTRACT(month FROM p_date)::int,
        EXTRACT(day FROM p_date)::int,
        p_hour,
        0,
        0,
        'UTC'
    );
    end_window := start_window + interval '1 hour';

    INSERT INTO service.notification_analytics (
        date,
        hour,
        template_id,
        device_type,
        total_sent,
        total_delivered,
        total_failed,
        total_pending,
        avg_delivery_time_ms,
        delivery_rate,
        failure_rate,
        error_invalid_token,
        error_quota_exceeded,
        error_server_error,
        error_timeout,
        error_unknown,
        created_at,
        updated_at
    )
    SELECT
        p_date,
        p_hour,
        n.template_id,
        COALESCE(uft.device_type, 'unknown') AS device_type,
        COUNT(*) AS total_sent,
        COUNT(*) FILTER (WHERE n.status = 'delivered') AS total_delivered,
        COUNT(*) FILTER (WHERE n.status = 'failed') AS total_failed,
        COUNT(*) FILTER (WHERE n.status = 'pending') AS total_pending,
        AVG(
            CASE
                WHEN n.delivered_at IS NOT NULL AND n.sent_at IS NOT NULL THEN
                    EXTRACT(EPOCH FROM (n.delivered_at - n.sent_at)) * 1000
            END
        )::integer AS avg_delivery_time_ms,
        ROUND(
            (COUNT(*) FILTER (WHERE n.status = 'delivered')::numeric / NULLIF(COUNT(*), 0)) * 100,
            2
        ) AS delivery_rate,
        ROUND(
            (COUNT(*) FILTER (WHERE n.status = 'failed')::numeric / NULLIF(COUNT(*), 0)) * 100,
            2
        ) AS failure_rate,
        COUNT(*) FILTER (WHERE n.failure_reason = 'invalid_token') AS error_invalid_token,
        COUNT(*) FILTER (WHERE n.failure_reason = 'quota_exceeded') AS error_quota_exceeded,
        COUNT(*) FILTER (WHERE n.failure_reason = 'server_error') AS error_server_error,
        COUNT(*) FILTER (WHERE n.failure_reason = 'timeout') AS error_timeout,
        COUNT(*) FILTER (WHERE n.failure_reason IS NULL OR n.failure_reason = 'unknown') AS error_unknown,
        timezone('utc', now()),
        timezone('utc', now())
    FROM service.notifications n
    LEFT JOIN LATERAL (
        SELECT DISTINCT ON (user_id) user_id, device_type
        FROM service.user_fcm_tokens
        WHERE user_id = n.user_id AND is_active = true
        ORDER BY user_id, last_used_at DESC NULLS LAST
    ) uft ON uft.user_id = n.user_id
    WHERE n.created_at >= start_window
      AND n.created_at < end_window
    GROUP BY n.template_id, COALESCE(uft.device_type, 'unknown')
    ON CONFLICT (date, hour, template_id, device_type)
    DO UPDATE SET
        total_sent = EXCLUDED.total_sent,
        total_delivered = EXCLUDED.total_delivered,
        total_failed = EXCLUDED.total_failed,
        total_pending = EXCLUDED.total_pending,
        avg_delivery_time_ms = EXCLUDED.avg_delivery_time_ms,
        delivery_rate = EXCLUDED.delivery_rate,
        failure_rate = EXCLUDED.failure_rate,
        error_invalid_token = EXCLUDED.error_invalid_token,
        error_quota_exceeded = EXCLUDED.error_quota_exceeded,
        error_server_error = EXCLUDED.error_server_error,
        error_timeout = EXCLUDED.error_timeout,
        error_unknown = EXCLUDED.error_unknown,
        updated_at = EXCLUDED.updated_at;
END;
$$;

COMMENT ON FUNCTION service.aggregate_notification_analytics(date, integer) IS 'Aggregates notification performance metrics per template/device_type for the specified UTC date+hour window.';

CREATE OR REPLACE FUNCTION service.update_template_stats(p_template_id uuid, p_success boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = service, public, auth
AS $$
BEGIN
    UPDATE service.notification_templates AS t
    SET
        usage_count = t.usage_count + 1,
        success_rate = ROUND(
            (
                ((t.success_rate / 100.0) * t.usage_count + CASE WHEN p_success THEN 1 ELSE 0 END)
                / NULLIF(t.usage_count + 1, 0)
            ) * 100,
            2
        ),
        updated_at = timezone('utc', now())
    WHERE t.id = p_template_id;
END;
$$;

COMMENT ON FUNCTION service.update_template_stats(uuid, boolean) IS 'Keeps notification_templates usage_count and success_rate in sync after deliveries.';
