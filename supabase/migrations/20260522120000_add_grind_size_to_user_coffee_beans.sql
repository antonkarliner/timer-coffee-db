-- Add an optional per-bean grind size so a bean record can carry its own
-- preferred grind setting, which is applied (with highest priority) when the
-- bean is attached to a recipe. Synced across devices for signed-in users.
ALTER TABLE public.user_coffee_beans
  ADD COLUMN IF NOT EXISTS grind_size character varying NULL;
