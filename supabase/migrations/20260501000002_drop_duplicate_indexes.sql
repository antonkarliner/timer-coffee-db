-- Drop standalone duplicate btree index on coffee_roasters.normalized_name.
-- coffee_roasters_normalized_name_idx covers the same column with the same definition.
-- The other "duplicate" UNIQUE constraints (brewing_methods, supported_locales, vendors)
-- are referenced by foreign keys so they cannot be dropped without cascading rewrites.
DROP INDEX IF EXISTS public.idx_coffee_roasters_normalized_name;
