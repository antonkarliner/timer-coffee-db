-- Rate limiting table for API request tracking
-- Used by the rate limiter module to prevent abuse

create table if not exists service.rate_limits (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users(id) on delete cascade,
    ip_address text,
    timestamp timestamptz not null default timezone('utc', now()),
    endpoint text,
    created_at timestamptz not null default timezone('utc', now())
);

-- Indexes for efficient rate limit queries
create index if not exists idx_rate_limits_user_timestamp on service.rate_limits(user_id, timestamp desc);
create index if not exists idx_rate_limits_ip_timestamp on service.rate_limits(ip_address, timestamp desc);
create index if not exists idx_rate_limits_timestamp on service.rate_limits(timestamp desc);

-- Enable RLS
alter table service.rate_limits enable row level security;

-- Only service role can manage rate limits
create policy "Service role manage rate limits" on service.rate_limits
    for all using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');

-- Clean up old entries automatically (older than 24 hours)
create or replace function service.cleanup_old_rate_limits()
returns void
language plpgsql
security definer
as $$
begin
    delete from service.rate_limits 
    where timestamp < timezone('utc', now()) - interval '24 hours';
end;
$$;

-- Schedule cleanup function to run every hour
select cron.schedule(
    'cleanup-rate-limits',
    '0 * * * *', -- Every hour at minute 0
    'select service.cleanup_old_rate_limits();'
);

comment on table service.rate_limits is 'Tracks API requests for rate limiting purposes.';
comment on column service.rate_limits.user_id is 'User ID for authenticated requests.';
comment on column service.rate_limits.ip_address is 'IP address for anonymous requests.';
comment on column service.rate_limits.endpoint is 'API endpoint that was accessed.';