-- Plan 040 §3/§5: preserve scheduled recipients and expose broadcast targeting to the worker.
-- Built from the supplied 2026-10-03 live definition. Existing table ACL/RLS stay unchanged.
begin;

alter table service.scheduled_notifications
  add column audience text not null default 'user'
    check (audience in ('user', 'broadcast')),
  add column platform text not null default 'all'
    check (platform in ('all', 'ios', 'android', 'web')),
  add column target_user_ids uuid[],
  add column created_by uuid;

update service.scheduled_notifications set created_by = user_id;
alter table service.scheduled_notifications
  alter column user_id drop not null,
  add constraint scheduled_notifications_recipient_kind_check
    check ((audience = 'user') = (user_id is not null)),
  add constraint scheduled_notifications_target_users_check
    check (target_user_ids is null or audience = 'broadcast');

-- The existing own-user policy cannot insert a broadcast: it requires a non-null
-- matching user_id, while the recipient constraint requires broadcast user_id NULL.
-- No new tables, grants or policies are needed; the existing table ACL is preserved.
drop function service.lock_due_scheduled_notifications(integer);
create function service.lock_due_scheduled_notifications(p_limit integer)
returns table (
  id uuid, user_id uuid, template_id uuid, template_name text,
  template_data jsonb, title text, body text, data jsonb, priority text,
  category text, schedule_at timestamptz, recurrence text, recurrence_data jsonb,
  quiet_hours_override boolean, locale text, translate boolean,
  audience text, platform text, target_user_ids uuid[], created_by uuid
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
              s.recurrence, s.recurrence_data, s.quiet_hours_override,
              s.locale, s.translate, s.audience, s.platform, s.target_user_ids,
              s.created_by;
end;
$$;

revoke execute on function service.lock_due_scheduled_notifications(integer) from public;
revoke execute on function service.lock_due_scheduled_notifications(integer) from anon;
revoke execute on function service.lock_due_scheduled_notifications(integer) from authenticated;
grant execute on function service.lock_due_scheduled_notifications(integer) to service_role;
grant execute on function service.lock_due_scheduled_notifications(integer) to postgres;

commit;
