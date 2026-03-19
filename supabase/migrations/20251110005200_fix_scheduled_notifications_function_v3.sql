-- Fix ambiguous column reference in lock_due_scheduled_notifications function (v3)

drop function if exists service.lock_due_scheduled_notifications(integer);

create function service.lock_due_scheduled_notifications(p_limit integer default 100)
returns table (
    id uuid,
    user_id uuid,
    template_id uuid,
    template_name text,
    template_data jsonb,
    title text,
    body text,
    data jsonb,
    priority text,
    category text,
    schedule_at timestamptz,
    recurrence text,
    recurrence_data jsonb,
    quiet_hours_override boolean
)
language plpgsql
security definer
set search_path = service, public, auth
as $$
begin
    return query
    with cte as (
        select sn.id
        from service.scheduled_notifications as sn
        where sn.status = 'pending'
          and sn.schedule_at <= timezone('utc', now())
        order by sn.schedule_at asc
        limit p_limit
        for update skip locked
    )
    update service.scheduled_notifications as s
    set status = 'processing', last_attempt_at = timezone('utc', now())
    from cte
    where s.id = cte.id
    returning s.id, s.user_id, s.template_id, s.template_name, s.template_data,
              s.title, s.body, s.data, s.priority, s.category, s.schedule_at,
              s.recurrence, s.recurrence_data, s.quiet_hours_override;
end;
$$;

comment on function service.lock_due_scheduled_notifications(integer) is 'Locks a batch of due scheduled notifications and returns them for processing.';