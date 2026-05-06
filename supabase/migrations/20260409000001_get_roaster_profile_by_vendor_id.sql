CREATE OR REPLACE FUNCTION public.get_roaster_profile_by_vendor_id(p_vendor_id text)
RETURNS json
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_uuid uuid;
  v_result     json;
BEGIN
  IF p_vendor_id IS NULL OR NOT (p_vendor_id LIKE 'usr-%') THEN
    RETURN NULL;
  END IF;
  BEGIN
    v_admin_uuid := (substring(p_vendor_id FROM 5))::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
  END;
  SELECT row_to_json(t)
  INTO   v_result
  FROM (
    SELECT
      id, slug, coffee_roaster_id, admin_user_id, roaster_name,
      roaster_logo_url, roaster_logo_mirror_url, dominant_color_hex,
      website_url, description, city, state, country, address_text,
      instagram_url, twitter_url, facebook_url, tiktok_url, is_active
    FROM   public.roaster_profiles
    WHERE  admin_user_id  = v_admin_uuid
      AND  is_active      = true
      AND  roaster_name   IS NOT NULL
    LIMIT  1
  ) t;
  RETURN v_result;
END;
$$;
