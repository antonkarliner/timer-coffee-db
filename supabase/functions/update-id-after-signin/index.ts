import { serve } from "https://deno.land/std@0.223.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.42.5";
import { resolveCaller } from "../_shared/caller-auth.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { logError, logInfo, logWarning } from "../_shared/monitoring.ts";
import {
  decideAfterOldUserLookup,
  decideBeforeOldUserLookup,
} from "./decide.ts";
// Fetching environment variables
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error(
    "Supabase URL or Service Role Key is not set in environment variables.",
  );
  Deno.exit(1);
}
// Create a Supabase client using the service role key for full access
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  cors: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function isMissingOldUserError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    status?: number;
    code?: string;
    message?: string;
  };
  return candidate.status === 400 || candidate.status === 404 ||
    candidate.code === "user_not_found" ||
    candidate.message?.toLowerCase().includes("not found") === true;
}
serve(async (req) => {
  const requestOrigin = req.headers.get("origin");
  const cors = getCorsHeaders(requestOrigin || undefined);
  console.log("Edge function called");
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: cors,
    });
  }
  if (req.method !== "POST") {
    console.log("Method not allowed");
    return new Response("Method Not Allowed", {
      status: 405,
      headers: cors,
    });
  }
  const callerResult = await resolveCaller(req, supabase);
  if (!callerResult.ok) {
    return jsonResponse(
      { error: callerResult.error },
      callerResult.status,
      cors,
    );
  }
  let body: { oldUserId?: string; newUserId?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400, cors);
  }
  const { oldUserId, newUserId } = body;
  console.log(`Received oldUserId: ${oldUserId}, newUserId: ${newUserId}`);
  if (!oldUserId || !newUserId) {
    console.log("Missing oldUserId or newUserId");
    return jsonResponse(
      { error: "Both oldUserId and newUserId are required" },
      400,
      cors,
    );
  }
  const initialDecision = decideBeforeOldUserLookup(
    callerResult.user,
    oldUserId,
    newUserId,
  );
  if (initialDecision.kind === "reject") {
    logWarning("Rejected user ID migration", {
      callerId: callerResult.user.id,
      oldUserId,
      requestedNewUserId: newUserId,
      error: initialDecision.error,
    });
    return jsonResponse(
      { error: initialDecision.error },
      initialDecision.status,
      cors,
    );
  }
  if (initialDecision.kind === "skip") {
    logInfo("Skipped user ID migration", {
      callerId: callerResult.user.id,
      oldUserId,
      reason: initialDecision.reason,
    });
    return jsonResponse({ skipped: initialDecision.reason }, 200, cors);
  }

  const { data: oldUserData, error: oldUserError } = await supabase.auth.admin
    .getUserById(oldUserId);
  if (oldUserError && !isMissingOldUserError(oldUserError)) {
    logError(
      "Failed to look up old user for migration",
      oldUserError,
      undefined,
      undefined,
      { callerId: callerResult.user.id, oldUserId },
    );
    return jsonResponse({ error: "Failed to look up old user" }, 500, cors);
  }
  const decision = decideAfterOldUserLookup(
    callerResult.user,
    oldUserId,
    oldUserError || !oldUserData.user ? { found: false } : {
      found: true,
      isAnonymous: oldUserData.user.is_anonymous === true,
    },
  );
  if (decision.kind === "skip") {
    const details = {
      callerId: callerResult.user.id,
      oldUserId,
      reason: decision.reason,
    };
    if (decision.reason === "old_user_not_anonymous") {
      logWarning("Skipped user ID migration", details);
    } else {
      logInfo("Skipped user ID migration", details);
    }
    return jsonResponse({ skipped: decision.reason }, 200, cors);
  }
  const migrationNewUserId = decision.newUserId;
  try {
    console.log("Updating global_stats table...");
    // Update global_stats table
    const { data: globalStatsData, error: globalStatsError } = await supabase
      .from("global_stats").update({
        user_id: migrationNewUserId,
      }).eq("user_id", oldUserId);
    if (globalStatsError) {
      console.error("Error updating global_stats:", globalStatsError);
      throw globalStatsError;
    }
    console.log("global_stats update result:", globalStatsData);
    console.log("Updating parse_coffee_label_invocations table...");
    // Update parse_coffee_label_invocations table
    const { data: invocationsData, error: invocationsError } = await supabase
      .from("parse_coffee_label_invocations").update({
        user_id: migrationNewUserId,
      }).eq("user_id", oldUserId);
    if (invocationsError) {
      console.error(
        "Error updating parse_coffee_label_invocations:",
        invocationsError,
      );
      throw invocationsError;
    }
    console.log(
      "parse_coffee_label_invocations update result:",
      invocationsData,
    );
    // --- Start: Update user_recipes and related tables ---
    console.log(`Fetching user_recipes for oldUserId: ${oldUserId}...`);
    const { data: userRecipes, error: fetchRecipesError } = await supabase.from(
      "user_recipes",
    ).select("id").eq("vendor_id", `usr-${oldUserId}`);
    if (fetchRecipesError) {
      console.error("Error fetching user_recipes:", fetchRecipesError);
      throw fetchRecipesError;
    }
    if (userRecipes && userRecipes.length > 0) {
      console.log(`Found ${userRecipes.length} recipes to update.`);
      const updatePromises = [];
      for (const recipe of userRecipes) {
        const oldRecipeId = recipe.id;
        // Ensure the ID format matches before attempting replacement
        if (oldRecipeId.startsWith(`usr-${oldUserId}-`)) {
          const newRecipeId = oldRecipeId.replace(
            `usr-${oldUserId}-`,
            `usr-${migrationNewUserId}-`,
          );
          const newVendorId = `usr-${migrationNewUserId}`;
          console.log(
            `Updating user_recipes: ${oldRecipeId} -> ${newRecipeId}, vendor_id -> ${newVendorId}`,
          );
          updatePromises.push(
            supabase.from("user_recipes").update({
              id: newRecipeId,
              vendor_id: newVendorId,
            }).eq("id", oldRecipeId),
          );
          console.log(
            `Updating user_recipe_localizations for recipe: ${oldRecipeId} -> ${newRecipeId}`,
          );
          updatePromises.push(
            supabase.from("user_recipe_localizations").update({
              recipe_id: newRecipeId,
            }).eq("recipe_id", oldRecipeId),
          );
          console.log(
            `Updating user_steps for recipe: ${oldRecipeId} -> ${newRecipeId}`,
          );
          updatePromises.push(
            supabase.from("user_steps").update({
              recipe_id: newRecipeId,
            }).eq("recipe_id", oldRecipeId),
          );
        } else {
          console.warn(
            `Recipe ID ${oldRecipeId} does not match expected format usr-${oldUserId}-, skipping update for this recipe.`,
          );
        }
      }
      console.log("Executing recipe update promises...");
      const results = await Promise.allSettled(updatePromises);
      const failedUpdates = results.filter((result) =>
        result.status === "rejected"
      );
      if (failedUpdates.length > 0) {
        console.error("Some recipe-related updates failed:", failedUpdates);
        // Throw the first error encountered
        throw failedUpdates[0].reason;
      }
      console.log("Recipe-related tables updated successfully.");
    } else {
      console.log(
        "No user_recipes found for oldUserId, skipping related updates.",
      );
    }
    // --- End: Update user_recipes and related tables ---
    // --- Start: Update user_fcm_tokens table ---
    console.log("Checking for FCM tokens to migrate...");
    const { data: fcmTokens, error: fcmCheckError } = await supabase.schema(
      "service",
    ).from("user_fcm_tokens").select("token").eq("user_id", oldUserId);
    if (fcmCheckError) {
      console.error("Error checking for FCM tokens:", fcmCheckError);
      throw fcmCheckError;
    }
    if (fcmTokens && fcmTokens.length > 0) {
      console.log(
        `Found ${fcmTokens.length} FCM token(s) to migrate from ${oldUserId} to ${migrationNewUserId}`,
      );
      const { data: fcmUpdateData, error: fcmUpdateError } = await supabase
        .schema("service").from("user_fcm_tokens").update({
          user_id: migrationNewUserId,
        }).eq("user_id", oldUserId);
      if (fcmUpdateError) {
        console.error("Error updating user_fcm_tokens:", fcmUpdateError);
        throw fcmUpdateError;
      }
      console.log("user_fcm_tokens update result:", fcmUpdateData);
    } else {
      console.log(
        "No FCM tokens found for migration (user may have never enabled notifications)",
      );
    }
    // --- End: Update user_fcm_tokens table ---
    console.log("Deleting old user...");
    // Delete the old user
    const { data: deleteData, error: deleteError } = await supabase.auth.admin
      .deleteUser(oldUserId, false);
    if (deleteError) {
      console.error("Error deleting old user:", deleteError);
      throw deleteError;
    }
    console.log("Old user deleted successfully");
    console.log("User ID update and deletion completed successfully");
    return new Response(
      JSON.stringify({
        message: "User ID updated and old user deleted successfully",
        globalStatsUpdated: globalStatsData,
        invocationsUpdated: invocationsData,
        fcmTokensUpdated: fcmTokens && fcmTokens.length > 0
          ? fcmTokens.length
          : 0,
        oldUserDeleted: deleteData,
      }),
      {
        status: 200,
        headers: {
          ...cors,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error
          ? error.message
          : "Unknown error occurred",
      }),
      {
        status: 500,
        headers: {
          ...cors,
          "Content-Type": "application/json",
        },
      },
    );
  }
});
