CREATE OR REPLACE FUNCTION service.lock_due_live_activity_events(p_limit integer DEFAULT 100)
 RETURNS TABLE(
    event_id uuid,
    session_id uuid,
    event_type text,
    scheduled_at timestamp with time zone,
    payload jsonb,
    attempts integer,
    user_id uuid,
    recipe_id text,
    recipe_name text,
    activity_id text,
    activity_push_token text,
    fcm_token text,
    step_durations_seconds integer[],
    step_descriptions text[],
    brew_started_at timestamp with time zone,
    total_duration_seconds integer,
    expected_end_at timestamp with time zone
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'service', 'public', 'auth'
AS $function$
begin
    return query
    with due as (
        select e.id
          from service.live_activity_events e
          join service.live_activity_sessions s
            on s.id = e.session_id
         where e.status = 'pending'
           and e.event_type in ('boundary', 'end')
           and s.status = 'active'
           and (
                (
                    e.event_type = 'boundary'
                    and e.scheduled_at <= timezone('utc', now()) + interval '5 seconds'
                    and coalesce(
                        case
                            when (e.payload ? 'effective_at_ms')
                              and (e.payload->>'effective_at_ms') ~ '^[0-9]+$'
                            then (e.payload->>'effective_at_ms')::bigint
                            else null
                        end,
                        floor(extract(epoch from e.scheduled_at) * 1000)::bigint
                    ) <= floor(extract(epoch from (timezone('utc', now()) + interval '2 seconds')) * 1000)::bigint
                )
                or
                (
                    e.event_type = 'end'
                    and e.scheduled_at <= timezone('utc', now())
                )
           )
         order by e.scheduled_at asc
         limit p_limit
         for update skip locked
    )
    update service.live_activity_events e
       set status = 'processing',
           attempts = e.attempts + 1,
           last_attempt_at = timezone('utc', now())
      from due
     where e.id = due.id
    returning
        e.id,
        e.session_id,
        e.event_type,
        e.scheduled_at,
        e.payload,
        e.attempts,
        (select s.user_id from service.live_activity_sessions s where s.id = e.session_id),
        (select s.recipe_id from service.live_activity_sessions s where s.id = e.session_id),
        (select s.recipe_name from service.live_activity_sessions s where s.id = e.session_id),
        (select s.activity_id from service.live_activity_sessions s where s.id = e.session_id),
        (select s.activity_push_token from service.live_activity_sessions s where s.id = e.session_id),
        (select s.fcm_token from service.live_activity_sessions s where s.id = e.session_id),
        (select s.step_durations_seconds from service.live_activity_sessions s where s.id = e.session_id),
        (select s.step_descriptions from service.live_activity_sessions s where s.id = e.session_id),
        (select s.brew_started_at from service.live_activity_sessions s where s.id = e.session_id),
        (select s.total_duration_seconds from service.live_activity_sessions s where s.id = e.session_id),
        (select s.expected_end_at from service.live_activity_sessions s where s.id = e.session_id);
end;
$function$;
