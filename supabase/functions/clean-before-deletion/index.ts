import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
// Fetching environment variables
const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error("Supabase URL or Service Role Key is not set in environment variables.");
  Deno.exit(1);
}
// Create a Supabase client using the service role key for full access
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
// Generic user ID to use for anonymization
const GENERIC_USER_ID = '00000000-0000-0000-0000-000000000000';
serve(async (req)=>{
  console.log('Anonymize and Delete User Data function called');
  if (req.method !== "POST") {
    console.log('Method not allowed');
    return new Response("Method Not Allowed", {
      status: 405
    });
  }
  const { user_id } = await req.json();
  console.log(`Received user_id: ${user_id}`);
  if (!user_id) {
    console.log('Missing user_id');
    return new Response(JSON.stringify({
      error: "user_id is required"
    }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
  try {
    // Anonymize data in global_stats
    console.log('Anonymizing data in global_stats table...');
    const { data: globalStatsData, error: globalStatsError } = await supabase.from('global_stats').update({
      user_id: GENERIC_USER_ID
    }).eq('user_id', user_id);
    if (globalStatsError) {
      console.error('Error anonymizing global_stats:', globalStatsError);
      throw globalStatsError;
    }
    console.log('global_stats anonymization result:', globalStatsData);
    // Anonymize data in parse_coffee_label_invocations
    console.log('Anonymizing data in parse_coffee_label_invocations table...');
    const { data: invocationsData, error: invocationsError } = await supabase.from('parse_coffee_label_invocations').update({
      user_id: GENERIC_USER_ID
    }).eq('user_id', user_id);
    if (invocationsError) {
      console.error('Error anonymizing parse_coffee_label_invocations:', invocationsError);
      throw invocationsError;
    }
    console.log('parse_coffee_label_invocations anonymization result:', invocationsData);
    // Delete data from user_stats
    console.log('Deleting data from user_stats table...');
    const { data: userStatsData, error: userStatsError } = await supabase.from('user_stats').delete().eq('user_id', user_id);
    if (userStatsError) {
      console.error('Error deleting from user_stats:', userStatsError);
      throw userStatsError;
    }
    console.log('user_stats deletion result:', userStatsData);
    // Delete data from user_coffee_beans
    console.log('Deleting data from user_coffee_beans table...');
    const { data: userCoffeeBeansData, error: userCoffeeBeansError } = await supabase.from('user_coffee_beans').delete().eq('user_id', user_id);
    if (userCoffeeBeansError) {
      console.error('Error deleting from user_coffee_beans:', userCoffeeBeansError);
      throw userCoffeeBeansError;
    }
    console.log('user_coffee_beans deletion result:', userCoffeeBeansData);
    // Delete data from user_recipe_preferences
    console.log('Deleting data from user_recipe_preferences table...');
    const { data: userRecipePreferencesData, error: userRecipePreferencesError } = await supabase.from('user_recipe_preferences').delete().eq('user_id', user_id);
    if (userRecipePreferencesError) {
      console.error('Error deleting from user_recipe_preferences:', userRecipePreferencesError);
      throw userRecipePreferencesError;
    }
    console.log('user_recipe_preferences deletion result:', userRecipePreferencesData);
    // Delete data from user_public_profiles table...
    console.log('Deleting data from user_public_profiles table...');
    const { data: userPublicProfilesData, error: userPublicProfilesError } = await supabase.from('user_public_profiles').delete().eq('user_id', user_id);
    if (userPublicProfilesError) {
      console.error('Error deleting from user_public_profiles:', userPublicProfilesError);
      throw userPublicProfilesError;
    }
    console.log('user_public_profiles deletion result:', userPublicProfilesData);
    // Delete data from user_recipes table by vendor_id...
    console.log('Deleting data from user_recipes table by vendor_id...');
    const { data: userRecipesData, error: userRecipesError } = await supabase.from('user_recipes').delete().eq('vendor_id', `usr-${user_id}`);
    if (userRecipesError) {
      console.error('Error deleting from user_recipes:', userRecipesError);
      throw userRecipesError;
    }
    console.log('user_recipes deletion result:', userRecipesData);
    // --- Start: Delete FCM tokens ---
    console.log('Deleting FCM tokens from user_fcm_tokens table...');
    const { data: fcmTokensData, error: fcmTokensError } = await supabase.schema('service').from('user_fcm_tokens').delete().eq('user_id', user_id);
    if (fcmTokensError) {
      console.error('Error deleting from user_fcm_tokens:', fcmTokensError);
      throw fcmTokensError;
    }
    // Type assertion to handle the delete operation result
    const deletedTokensCount = fcmTokensData?.length || 0;
    console.log(`user_fcm_tokens deletion result: ${deletedTokensCount} token(s) deleted`);
    // --- End: Delete FCM tokens ---
    // --- Start: Delete bean cover photos from Storage ---
    console.log('Deleting bean cover photos from Storage...');
    const { data: beanPhotoFiles, error: listError } = await supabase.storage.from('bean-photos').list(user_id);
    if (listError) {
      // Bucket may not exist or folder may be empty - treat as non-fatal
      console.warn('Could not list bean photos (bucket may be empty or not exist):', listError);
    } else if (beanPhotoFiles && beanPhotoFiles.length > 0) {
      const filePaths = beanPhotoFiles.map((f)=>`${user_id}/${f.name}`);
      const { error: removeError } = await supabase.storage.from('bean-photos').remove(filePaths);
      if (removeError) {
        console.error('Error deleting bean photos from Storage:', removeError);
        throw removeError;
      }
      console.log(`Deleted ${filePaths.length} bean photo(s) from Storage`);
    } else {
      console.log('No bean photos found in Storage for this user');
    }
    // --- End: Delete bean cover photos from Storage ---
    // Delete the user
    console.log('Deleting the user...');
    const { data: deleteUserData, error: deleteUserError } = await supabase.auth.admin.deleteUser(user_id, false // Set to true for soft delete
    );
    if (deleteUserError) {
      console.error('Error deleting user:', deleteUserError);
      throw deleteUserError;
    }
    console.log('User deleted successfully');
    console.log('User data anonymization, deletion, and user removal completed successfully');
    return new Response(JSON.stringify({
      message: "User data anonymized, deleted, and user removed successfully",
      globalStatsAnonymized: globalStatsData,
      invocationsAnonymized: invocationsData,
      userStatsDeleted: userStatsData,
      userCoffeeBeansDeleted: userCoffeeBeansData,
      userRecipePreferencesDeleted: userRecipePreferencesData,
      userPublicProfilesDeleted: userPublicProfilesData,
      userRecipesDeleted: userRecipesData,
      fcmTokensDeleted: deletedTokensCount,
      userDeleted: deleteUserData
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    return new Response(JSON.stringify({
      error: errorMessage
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
});
