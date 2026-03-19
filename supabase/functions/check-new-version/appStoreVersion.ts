// supabase/functions/check-new-version/appStoreVersion.ts

import { generateAppStoreJWT } from "./generateAppStoreJWT.ts";
import { AppStoreListAppsResponse, AppStoreVersionResponse } from "./types.ts";
import { compareVersionStrings } from "./versionUtils.ts";

// Function to fetch the App Store Connect App Resource ID using bundleId
async function getAppResourceId(bundleId: string): Promise<string | null> {
  const issuerId = Deno.env.get("APPSTORE_ISSUER_ID");
  const keyId = Deno.env.get("APPSTORE_KEY_ID");
  const privateKeyEnv = Deno.env.get("APPSTORE_PRIVATE_KEY");

  if (!issuerId || !keyId || !privateKeyEnv) {
    console.error("App Store Connect credentials are not set.");
    return null;
  }

  // Replace \n with actual newlines
  const privateKey = privateKeyEnv.replace(/\\n/g, "\n");

  const jwt = await generateAppStoreJWT(issuerId, keyId, privateKey);

  const url = `https://api.appstoreconnect.apple.com/v1/apps?filter[bundleId]=${
    encodeURIComponent(
      bundleId,
    )
  }&limit=1`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.error("Failed to fetch App Store apps:", await response.text());
      return null;
    }

    const data: AppStoreListAppsResponse = await response.json();

    if (data.data.length === 0) {
      console.error("No app found with the provided bundle ID.");
      return null;
    }

    const appId = data.data[0].id;
    return appId;
  } catch (error) {
    console.error("Error fetching App Store resource ID:", error);
    return null;
  }
}

// Function to fetch the latest App Store version with appStoreState = READY_FOR_SALE
export async function getAppStoreVersion(): Promise<string | null> {
  const bundleId = "timer.coffee"; // Your app's bundle ID

  const appId = await getAppResourceId(bundleId);

  if (!appId) {
    return null;
  }

  const issuerId = Deno.env.get("APPSTORE_ISSUER_ID");
  const keyId = Deno.env.get("APPSTORE_KEY_ID");
  const privateKeyEnv = Deno.env.get("APPSTORE_PRIVATE_KEY");

  if (!issuerId || !keyId || !privateKeyEnv) {
    console.error("App Store Connect credentials are not set.");
    return null;
  }

  // Replace \n with actual newlines
  const privateKey = privateKeyEnv.replace(/\\n/g, "\n");

  const jwt = await generateAppStoreJWT(issuerId, keyId, privateKey);

  // Removed 'sort' parameter, set limit to a reasonable number
  const url =
    `https://api.appstoreconnect.apple.com/v1/apps/${appId}/appStoreVersions?filter[appStoreState]=READY_FOR_SALE&limit=50`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.error(
        "Failed to fetch App Store versions:",
        await response.text(),
      );
      return null;
    }

    const data: AppStoreVersionResponse = await response.json();

    if (data.data.length === 0) {
      console.log("No ready versions found in App Store.");
      return null;
    }

    let latestVersionString = data.data[0].attributes.versionString;

    for (const version of data.data) {
      const currentVersionString = version.attributes.versionString;

      if (
        compareVersionStrings(currentVersionString, latestVersionString) > 0
      ) {
        latestVersionString = currentVersionString;
      }
    }

    return latestVersionString;
  } catch (error) {
    console.error("Error fetching App Store version:", error);
    return null;
  }
}
