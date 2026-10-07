-- Security F14: failed and concurrent recipe verifications evaded usage limits.
--
-- verify-user-recipe-draft counted only successful invocations, checked the
-- hourly limit with a read-then-call, and read the OpenAI daily budget without
-- reserving it, so parallel requests overspent and failed attempts (provider
-- errors, truncation, bad JSON, step-count mismatch) were free to retry.
--
-- Now every admitted request inserts its invocation row first, under a per-user
-- advisory lock, so it counts toward the rolling-hour limit whatever happens
-- next. The same call reserves a conservative OpenAI token upper bound against
-- the UTC-day budget under a global lock; finalisation records the actual
-- usage reported for every billed attempt and releases the reservation, unless
-- some OpenAI attempt's billing is unknown, in which case it stays reserved
-- for the rest of the day. The column defaults mark existing rows, and rows
-- written by the previously deployed function during cutover, as succeeded.
alter table service.user_recipe_verification_invocations
  add column status text not null default 'succeeded' check (status in ('reserved', 'succeeded', 'failed')),
  add column openai_tokens_reserved bigint not null default 0 check (openai_tokens_reserved >= 0),
  add column billing_unknown boolean not null default false,
  add column completed_at timestamptz;

revoke all on table service.user_recipe_verification_invocations from public;
revoke all on table service.user_recipe_verification_invocations from anon;
revoke all on table service.user_recipe_verification_invocations from authenticated;
grant select, insert, update, delete on table service.user_recipe_verification_invocations to service_role;
revoke all on sequence service.user_recipe_verification_invocations_id_seq from anon, authenticated;
grant usage, select on sequence service.user_recipe_verification_invocations_id_seq to service_role;

create function service.admit_recipe_verification(
  p_user_id uuid, p_hourly_limit integer, p_openai_daily_budget bigint, p_openai_reservation bigint
) returns table (admitted boolean, invocation_id bigint, openai_allowed boolean)
language plpgsql security invoker set search_path = '' as $$
declare
  recent_count bigint;
  today numeric;
  new_id bigint;
  allowed boolean;
begin
  if p_user_id is null or p_hourly_limit is null or p_hourly_limit <= 0
    or p_openai_daily_budget is null or p_openai_daily_budget < 0
    or p_openai_reservation is null or p_openai_reservation <= 0 then
    raise exception 'Invalid verification admission arguments' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('recipe-verification-user:' || p_user_id::text, 0));
  select count(*) into recent_count from service.user_recipe_verification_invocations
    where user_id = p_user_id and invoked_at > now() - interval '1 hour';
  if recent_count >= p_hourly_limit then
    return query select false, null::bigint, false;
    return;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('recipe-verification-openai-budget', 0));
  select coalesce(sum(openai_tokens_used::numeric + openai_tokens_reserved), 0) into today
    from service.user_recipe_verification_invocations
    where invoked_at >= pg_catalog.date_trunc('day', now(), 'UTC');
  allowed := today + p_openai_reservation <= p_openai_daily_budget;
  insert into service.user_recipe_verification_invocations
    (user_id, status, tokens_used, openai_tokens_used, provider_used, provider_model_used, openai_tokens_reserved)
    values (p_user_id, 'reserved', 0, 0, 'pending', 'pending', case when allowed then p_openai_reservation else 0 end)
    returning id into new_id;
  return query select true, new_id, allowed;
end;
$$;

create function service.finalize_recipe_verification(
  p_invocation_id bigint, p_status text, p_tokens_used bigint, p_openai_tokens_used bigint,
  p_provider_used text, p_provider_model_used text, p_billing_unknown boolean
) returns boolean
language plpgsql security invoker set search_path = '' as $$
begin
  if p_invocation_id is null or p_status is null or p_status not in ('succeeded', 'failed')
    or p_tokens_used is null or p_tokens_used < 0
    or p_openai_tokens_used is null or p_openai_tokens_used < 0
    or p_openai_tokens_used > p_tokens_used or p_billing_unknown is null then
    raise exception 'Invalid verification finalization arguments' using errcode = '22023';
  end if;
  update service.user_recipe_verification_invocations
    set status = p_status, tokens_used = p_tokens_used, openai_tokens_used = p_openai_tokens_used,
      provider_used = coalesce(p_provider_used, provider_used),
      provider_model_used = coalesce(p_provider_model_used, provider_model_used),
      billing_unknown = p_billing_unknown, completed_at = now(),
      openai_tokens_reserved = case when p_billing_unknown then openai_tokens_reserved else 0 end
    where id = p_invocation_id and status = 'reserved';
  return found;
end;
$$;

revoke execute on function service.admit_recipe_verification(uuid, integer, bigint, bigint) from public;
revoke execute on function service.admit_recipe_verification(uuid, integer, bigint, bigint) from anon;
revoke execute on function service.admit_recipe_verification(uuid, integer, bigint, bigint) from authenticated;
grant execute on function service.admit_recipe_verification(uuid, integer, bigint, bigint) to service_role;
grant execute on function service.admit_recipe_verification(uuid, integer, bigint, bigint) to postgres;
revoke execute on function service.finalize_recipe_verification(bigint, text, bigint, bigint, text, text, boolean) from public;
revoke execute on function service.finalize_recipe_verification(bigint, text, bigint, bigint, text, text, boolean) from anon;
revoke execute on function service.finalize_recipe_verification(bigint, text, bigint, bigint, text, text, boolean) from authenticated;
grant execute on function service.finalize_recipe_verification(bigint, text, bigint, bigint, text, text, boolean) to service_role;
grant execute on function service.finalize_recipe_verification(bigint, text, bigint, bigint, text, text, boolean) to postgres;
