-- Allow bean reviews to be submitted before the roaster has a profile in the
-- directory. Reviews are stored with roaster_name and linked automatically
-- via trigger when the roaster profile is eventually created.

-- 1. Add roaster_name column to capture the roaster name at review time.
ALTER TABLE bean_reviews
  ADD COLUMN roaster_name TEXT NOT NULL DEFAULT '';

-- 2. Backfill roaster_name from the linked roaster_profiles row.
UPDATE bean_reviews br
SET roaster_name = rp.roaster_name
FROM roaster_profiles rp
WHERE br.roaster_profile_id = rp.id;

-- 3. Make roaster_profile_id nullable (FK constraint stays, just allows NULL).
ALTER TABLE bean_reviews
  ALTER COLUMN roaster_profile_id DROP NOT NULL;

-- 4. Drop the old unique constraint that included roaster_profile_id.
ALTER TABLE bean_reviews
  DROP CONSTRAINT bean_reviews_user_id_roaster_profile_id_bean_name_key;

-- 5. Add new unique constraint on (user_id, roaster_name, bean_name).
--    Prevents duplicate pending reviews for the same roaster+bean per user.
--    Works for both linked (roaster_profile_id set) and pending (NULL) reviews.
ALTER TABLE bean_reviews
  ADD CONSTRAINT bean_reviews_user_id_roaster_name_bean_name_key
  UNIQUE (user_id, roaster_name, bean_name);

-- 6. Trigger function: auto-link pending reviews when a roaster profile is
--    created or its roaster_name changes.
CREATE OR REPLACE FUNCTION link_pending_bean_reviews()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE bean_reviews
  SET roaster_profile_id = NEW.id
  WHERE roaster_profile_id IS NULL
    AND lower(trim(roaster_name)) = lower(trim(NEW.roaster_name));
  RETURN NEW;
END;
$$;

-- 7. Attach trigger to roaster_profiles INSERT and UPDATE (roaster_name changes).
DROP TRIGGER IF EXISTS trg_link_pending_bean_reviews ON roaster_profiles;
CREATE TRIGGER trg_link_pending_bean_reviews
  AFTER INSERT OR UPDATE OF roaster_name ON roaster_profiles
  FOR EACH ROW
  EXECUTE FUNCTION link_pending_bean_reviews();
