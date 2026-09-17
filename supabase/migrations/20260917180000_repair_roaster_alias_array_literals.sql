-- Plan 037: re-encode stored array literals as comma-separated aliases.
-- Update only aliases; normalize_roaster_fields derives normalized_aliases.
-- Production preflight: 21 full literals, one hybrid, one generic alias.
update public.coffee_roasters
set aliases = nullif(array_to_string(aliases::text[], ','), '')
where aliases ~ '^\{.*\}$';

do $$
begin
  update public.coffee_roasters
  set aliases = 'Pascal,Pascal Roastery,Cafe Pascal,Pascal Coffee Roastery'
  where id = 1182
    and aliases = '{Pascal,"Pascal Roastery","Cafe Pascal"},Pascal Coffee Roastery';
  if not found then
    raise exception 'Plan 037: Cafe Pascal aliases changed; re-read row 1182';
  end if;

  update public.coffee_roasters
  set aliases = 'portrait,Portrait Coffee'
  where id = 541 and aliases = 'portrait,Portrait, Coffee';
  if not found then
    raise exception 'Plan 037: Portrait Coffee aliases changed; re-read row 541';
  end if;
end;
$$;
