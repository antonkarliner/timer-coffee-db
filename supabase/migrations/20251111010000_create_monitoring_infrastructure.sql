-- Create service.system_logs table for centralized logging
CREATE TABLE IF NOT EXISTS service.system_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    correlation_id UUID NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    level VARCHAR(20) NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error', 'fatal')),
    service VARCHAR(100) NOT NULL,
    function_name VARCHAR(200),
    user_id UUID,
    ip_address INET,
    user_agent TEXT,
    message TEXT NOT NULL,
    details JSONB,
    duration_ms INTEGER,
    memory_usage_mb INTEGER,
    error_category VARCHAR(50),
    error_severity VARCHAR(20) CHECK (error_severity IN ('low', 'medium', 'high', 'critical')),
    request_id VARCHAR(100),
    endpoint VARCHAR(200),
    method VARCHAR(10),
    status_code INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_system_logs_timestamp ON service.system_logs (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_correlation_id ON service.system_logs (correlation_id);
CREATE INDEX IF NOT EXISTS idx_system_logs_level ON service.system_logs (level);
CREATE INDEX IF NOT EXISTS idx_system_logs_service ON service.system_logs (service);
CREATE INDEX IF NOT EXISTS idx_system_logs_user_id ON service.system_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_system_logs_error_category ON service.system_logs (error_category) WHERE error_category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_system_logs_endpoint ON service.system_logs (endpoint) WHERE endpoint IS NOT NULL;

-- Create service.performance_metrics table for tracking system performance
CREATE TABLE IF NOT EXISTS service.performance_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    service VARCHAR(100) NOT NULL,
    endpoint VARCHAR(200),
    method VARCHAR(10),
    avg_response_time_ms DECIMAL(10,2),
    p95_response_time_ms DECIMAL(10,2),
    p99_response_time_ms DECIMAL(10,2),
    request_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    success_rate DECIMAL(5,2),
    memory_usage_avg_mb DECIMAL(10,2),
    cpu_usage_avg_percent DECIMAL(5,2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes for performance metrics
CREATE INDEX IF NOT EXISTS idx_performance_metrics_timestamp ON service.performance_metrics (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_performance_metrics_service ON service.performance_metrics (service);
CREATE INDEX IF NOT EXISTS idx_performance_metrics_endpoint ON service.performance_metrics (endpoint) WHERE endpoint IS NOT NULL;

-- Create service.usage_analytics table for tracking usage patterns
CREATE TABLE IF NOT EXISTS service.usage_analytics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date DATE NOT NULL,
    hour INTEGER CHECK (hour >= 0 AND hour <= 23),
    service VARCHAR(100) NOT NULL,
    endpoint VARCHAR(200),
    user_id UUID,
    device_type VARCHAR(20),
    notification_count INTEGER DEFAULT 0,
    api_calls INTEGER DEFAULT 0,
    unique_users INTEGER DEFAULT 0,
    total_response_time_ms BIGINT DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(date, hour, service, endpoint, user_id, device_type)
);

-- Create indexes for usage analytics
CREATE INDEX IF NOT EXISTS idx_usage_analytics_date ON service.usage_analytics (date DESC);
CREATE INDEX IF NOT EXISTS idx_usage_analytics_service ON service.usage_analytics (service);
CREATE INDEX IF NOT EXISTS idx_usage_analytics_user_id ON service.usage_analytics (user_id) WHERE user_id IS NOT NULL;

-- Create service.health_checks table for tracking system health
CREATE TABLE IF NOT EXISTS service.health_checks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    service VARCHAR(100) NOT NULL,
    component VARCHAR(100) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('healthy', 'degraded', 'unhealthy')),
    response_time_ms INTEGER,
    details JSONB,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes for health checks
CREATE INDEX IF NOT EXISTS idx_health_checks_timestamp ON service.health_checks (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_health_checks_service ON service.health_checks (service);
CREATE INDEX IF NOT EXISTS idx_health_checks_component ON service.health_checks (component);
CREATE INDEX IF NOT EXISTS idx_health_checks_status ON service.health_checks (status);

-- Create service.alert_thresholds table for configuring alerting
CREATE TABLE IF NOT EXISTS service.alert_thresholds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL UNIQUE,
    metric_type VARCHAR(50) NOT NULL,
    threshold_value DECIMAL(10,2) NOT NULL,
    comparison_operator VARCHAR(10) NOT NULL CHECK (comparison_operator IN ('>', '<', '>=', '<=', '=', '!=')),
    severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    notification_channels JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create function to update updated_at columns
CREATE OR REPLACE FUNCTION service.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at columns
CREATE TRIGGER update_system_logs_updated_at BEFORE UPDATE ON service.system_logs
    FOR EACH ROW EXECUTE FUNCTION service.update_updated_at_column();

CREATE TRIGGER update_performance_metrics_updated_at BEFORE UPDATE ON service.performance_metrics
    FOR EACH ROW EXECUTE FUNCTION service.update_updated_at_column();

CREATE TRIGGER update_usage_analytics_updated_at BEFORE UPDATE ON service.usage_analytics
    FOR EACH ROW EXECUTE FUNCTION service.update_updated_at_column();

CREATE TRIGGER update_health_checks_updated_at BEFORE UPDATE ON service.health_checks
    FOR EACH ROW EXECUTE FUNCTION service.update_updated_at_column();

CREATE TRIGGER update_alert_thresholds_updated_at BEFORE UPDATE ON service.alert_thresholds
    FOR EACH ROW EXECUTE FUNCTION service.update_updated_at_column();

-- Create function for log cleanup (retention policy)
CREATE OR REPLACE FUNCTION service.cleanup_old_logs()
RETURNS void AS $$
BEGIN
    -- Delete system logs older than 90 days
    DELETE FROM service.system_logs 
    WHERE timestamp < NOW() - INTERVAL '90 days';
    
    -- Delete performance metrics older than 1 year
    DELETE FROM service.performance_metrics 
    WHERE timestamp < NOW() - INTERVAL '1 year';
    
    -- Delete usage analytics older than 2 years
    DELETE FROM service.usage_analytics 
    WHERE date < CURRENT_DATE - INTERVAL '2 years';
    
    -- Delete health checks older than 30 days
    DELETE FROM service.health_checks 
    WHERE timestamp < NOW() - INTERVAL '30 days';
    
    RAISE NOTICE 'Old logs and metrics cleaned up successfully';
END;
$$ LANGUAGE plpgsql;

-- Create function to aggregate performance metrics
CREATE OR REPLACE FUNCTION service.aggregate_performance_metrics()
RETURNS void AS $$
BEGIN
    -- Aggregate performance metrics by hour
    INSERT INTO service.performance_metrics (service, endpoint, method, avg_response_time_ms, p95_response_time_ms, p99_response_time_ms, request_count, error_count, success_rate)
    SELECT 
        service,
        endpoint,
        method,
        AVG(duration_ms) as avg_response_time_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95_response_time_ms,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms) as p99_response_time_ms,
        COUNT(*) as request_count,
        COUNT(*) FILTER (WHERE status_code >= 400) as error_count,
        ROUND((COUNT(*) FILTER (WHERE status_code < 400) * 100.0 / COUNT(*)), 2) as success_rate
    FROM service.system_logs
    WHERE timestamp >= NOW() - INTERVAL '1 hour'
      AND endpoint IS NOT NULL
      AND duration_ms IS NOT NULL
    GROUP BY service, endpoint, method
    ON CONFLICT (timestamp, service, endpoint, method) DO UPDATE SET
        avg_response_time_ms = EXCLUDED.avg_response_time_ms,
        p95_response_time_ms = EXCLUDED.p95_response_time_ms,
        p99_response_time_ms = EXCLUDED.p99_response_time_ms,
        request_count = EXCLUDED.request_count,
        error_count = EXCLUDED.error_count,
        success_rate = EXCLUDED.success_rate,
        updated_at = NOW();
    
    RAISE NOTICE 'Performance metrics aggregated successfully';
END;
$$ LANGUAGE plpgsql;

-- Create function to check alert thresholds
CREATE OR REPLACE FUNCTION service.check_alert_thresholds()
RETURNS TABLE(threshold_name VARCHAR, metric_type VARCHAR, current_value DECIMAL, threshold_value DECIMAL, severity VARCHAR) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        at.name as threshold_name,
        at.metric_type,
        CASE 
            WHEN at.metric_type = 'error_rate' THEN 
                (SELECT ROUND((COUNT(*) FILTER (WHERE level = 'error') * 100.0 / NULLIF(COUNT(*), 0)), 2) 
                 FROM service.system_logs 
                 WHERE timestamp >= NOW() - INTERVAL '1 hour')
            WHEN at.metric_type = 'avg_response_time' THEN 
                (SELECT AVG(duration_ms) 
                 FROM service.system_logs 
                 WHERE timestamp >= NOW() - INTERVAL '1 hour' 
                   AND duration_ms IS NOT NULL)
            WHEN at.metric_type = 'memory_usage' THEN 
                (SELECT AVG(memory_usage_mb) 
                 FROM service.system_logs 
                 WHERE timestamp >= NOW() - INTERVAL '1 hour' 
                   AND memory_usage_mb IS NOT NULL)
            ELSE 0
        END as current_value,
        at.threshold_value,
        at.severity
    FROM service.alert_thresholds at
    WHERE at.is_active = true;
END;
$$ LANGUAGE plpgsql;

-- Enable RLS on all service tables
ALTER TABLE service.system_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE service.performance_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE service.usage_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE service.health_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE service.alert_thresholds ENABLE ROW LEVEL SECURITY;

-- Create policies for service tables (only service_role can access)
CREATE POLICY "Service role full access to system_logs" ON service.system_logs
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access to performance_metrics" ON service.performance_metrics
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access to usage_analytics" ON service.usage_analytics
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access to health_checks" ON service.health_checks
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access to alert_thresholds" ON service.alert_thresholds
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Grant necessary permissions
GRANT ALL ON service.system_logs TO service_role;
GRANT ALL ON service.performance_metrics TO service_role;
GRANT ALL ON service.usage_analytics TO service_role;
GRANT ALL ON service.health_checks TO service_role;
GRANT ALL ON service.alert_thresholds TO service_role;

GRANT EXECUTE ON FUNCTION service.cleanup_old_logs() TO service_role;
GRANT EXECUTE ON FUNCTION service.aggregate_performance_metrics() TO service_role;
GRANT EXECUTE ON FUNCTION service.check_alert_thresholds() TO service_role;

-- Insert default alert thresholds
INSERT INTO service.alert_thresholds (name, metric_type, threshold_value, comparison_operator, severity) VALUES
('High Error Rate', 'error_rate', 5.0, '>', 'high'),
('Critical Error Rate', 'error_rate', 10.0, '>', 'critical'),
('High Response Time', 'avg_response_time', 1000.0, '>', 'medium'),
('Critical Response Time', 'avg_response_time', 2000.0, '>', 'critical'),
('High Memory Usage', 'memory_usage', 512.0, '>', 'medium'),
('Critical Memory Usage', 'memory_usage', 1024.0, '>', 'critical')
ON CONFLICT (name) DO NOTHING;

-- Create cron job for log cleanup (runs daily at 2 AM)
SELECT cron.schedule(
    'cleanup-old-logs',
    '0 2 * * *',
    'SELECT service.cleanup_old_logs();'
);

-- Create cron job for performance metrics aggregation (runs every hour)
SELECT cron.schedule(
    'aggregate-performance-metrics',
    '0 * * * *',
    'SELECT service.aggregate_performance_metrics();'
);

-- Create cron job for alert checking (runs every 5 minutes)
SELECT cron.schedule(
    'check-alert-thresholds',
    '*/5 * * * *',
    'SELECT * FROM service.check_alert_thresholds();'
);