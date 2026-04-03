import { getAppStoreVersion } from "./appStoreVersion.ts";
import { getGooglePlayVersion } from "./googlePlayVersion.ts";
import { APP_RELEASE_NOTIFICATION_CHUNK_SIZE } from "./sendFcmNotification.ts";
import { supabase } from "./utils.ts";
import { compareVersionStrings } from "./versionUtils.ts";
Deno.serve(async (_req)=>{
  try {
    const { data: currentVersions, error } = await supabase.schema("service").from("app_version").select("platform, version");
    if (error) {
      console.error("Error fetching current versions:", error.message);
      return jsonResponse({
        success: false,
        error: error.message
      }, 500);
    }
    const versionMap = new Map();
    for (const row of currentVersions ?? []){
      versionMap.set(row.platform, row.version);
    }
    const [latestAppStoreVersion, latestGooglePlayVersion] = await Promise.all([
      getAppStoreVersion(),
      getGooglePlayVersion()
    ]);
    const updates = [];
    await maybeQueueRelease({
      platform: "ios",
      currentVersion: versionMap.get("ios") ?? null,
      latestVersion: latestAppStoreVersion,
      isNewer: isNewerIosVersion,
      updates
    });
    await maybeQueueRelease({
      platform: "android",
      currentVersion: versionMap.get("android") ?? null,
      latestVersion: latestGooglePlayVersion,
      isNewer: isNewerAndroidVersion,
      updates
    });
    return jsonResponse({
      success: true,
      message: "Update check completed",
      updates
    }, 200);
  } catch (error) {
    console.error("Unexpected error:", error);
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});
async function maybeQueueRelease({ platform, currentVersion, latestVersion, isNewer, updates }) {
  const platformLabel = platform === "ios" ? "iOS" : "Android";
  if (!latestVersion) {
    console.log(`[check-new-version] No ${platformLabel} store version was returned.`);
    return;
  }
  if (!currentVersion) {
    console.warn(`[check-new-version] ${platformLabel} has no stored version in service.app_version; skipping release claim for ${latestVersion}.`);
    return;
  }
  if (!isNewer(latestVersion, currentVersion)) {
    console.log(`[check-new-version] No new ${platformLabel} version detected. current=${currentVersion} latest=${latestVersion}`);
    return;
  }
  const claimed = await claimVersion(platform, currentVersion, latestVersion);
  if (!claimed) {
    console.log(`[check-new-version] ${platformLabel} ${latestVersion} was already claimed by another invocation.`);
    updates.push(`${platformLabel} ${latestVersion} already claimed`);
    return;
  }
  await enqueueReleaseNotification(platform, latestVersion);
  console.log(`[check-new-version] Queued ${platformLabel} release notification for ${latestVersion}.`);
  updates.push(`${platformLabel} queued for ${latestVersion}`);
}
async function claimVersion(platform, currentVersion, nextVersion) {
  const builder = supabase.schema("service").from("app_version").update({
    version: nextVersion
  }).eq("platform", platform);
  const query = currentVersion === null ? builder.is("version", null) : builder.eq("version", currentVersion);
  const { data, error } = await query.select("platform, version");
  if (error) {
    throw new Error(`Failed to claim ${platform} release ${nextVersion}: ${error.message}`);
  }
  return (data?.length ?? 0) === 1;
}
async function enqueueReleaseNotification(platform, version) {
  const { error } = await supabase.schema("service").from("app_release_notifications").upsert({
    platform,
    version,
    status: "pending",
    failure_reason: null,
    delivery_state: {
      chunkSize: APP_RELEASE_NOTIFICATION_CHUNK_SIZE
    }
  }, {
    onConflict: "platform,version",
    ignoreDuplicates: true
  });
  if (error) {
    throw new Error(`Failed to enqueue ${platform} release notification for ${version}: ${error.message}`);
  }
}
function isNewerIosVersion(latestVersion, currentVersion) {
  return compareVersionStrings(latestVersion, currentVersion) > 0;
}
function isNewerAndroidVersion(latestVersion, currentVersion) {
  return compareVersionStrings(latestVersion, currentVersion) > 0;
}
function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json"
    },
    status
  });
}
