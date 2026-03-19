set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.enqueue_popup(_content text, _locale text, _run_at timestamp with time zone)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    msg_id bigint;
BEGIN
    INSERT INTO pgmq.q_scheduled_launch_popup (message, deliver_on)
    VALUES (jsonb_build_object('content', _content, 'locale', _locale), _run_at)
    RETURNING msg_id INTO msg_id;
    RETURN msg_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.process_due_popups()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pgmq'
AS $function$
declare
  m pgmq.message_record;
begin
  loop
    /* read up to 25 ready-to-process messages */
    select *
      into m
      from pgmq.read('scheduled_launch_popup', 60, 25);
    exit when m is null;

    insert into public.launch_popup (content, locale)
    values (
      (m.message ->> 'content')::text,
      (m.message ->> 'locale') ::text
    );

    perform pgmq.delete('scheduled_launch_popup', m.msg_id);
  end loop;
end
$function$
;


create policy "allow insert for authenticated"
on "public"."launch_popup"
as permissive
for insert
to authenticated
with check (true);
