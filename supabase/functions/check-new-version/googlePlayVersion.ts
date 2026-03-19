// supabase/functions/check-new-version/googlePlayVersion.ts

// Function to obtain Google OAuth 2.0 access token using service account
async function getGoogleAccessToken(): Promise<string | null> {
    const serviceAccountJson = Deno.env.get("GOOGLE_PLAY_SERVICE_ACCOUNT");
  
    if (!serviceAccountJson) {
      console.error("Google Play service account credentials are not set.");
      return null;
    }
  
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(serviceAccountJson);
    } catch (error) {
      console.error("Invalid Google Play service account JSON:", error);
      return null;
    }
  
    const { client_email, private_key } = serviceAccount;
  
    if (!client_email || !private_key) {
      console.error("Invalid service account credentials.");
      return null;
    }
  
    // Generate JWT for OAuth 2.0
    const jwtHeader = {
      alg: "RS256",
      typ: "JWT",
    };
  
    const currentTime = Math.floor(Date.now() / 1000);
    const jwtPayload = {
      iss: client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: "https://oauth2.googleapis.com/token",
      exp: currentTime + 3600, // 1 hour
      iat: currentTime,
    };
  
    const headerBase64 = base64UrlEncode(JSON.stringify(jwtHeader));
    const payloadBase64 = base64UrlEncode(JSON.stringify(jwtPayload));
    const unsignedJWT = `${headerBase64}.${payloadBase64}`;
  
    // Sign the JWT using RS256
    try {
      const cryptoKey = await importRS256PrivateKey(private_key);
  
      const signature = await crypto.subtle.sign(
        {
          name: "RSASSA-PKCS1-v1_5",
        },
        cryptoKey,
        new TextEncoder().encode(unsignedJWT)
      );
  
      const signatureBase64 = base64UrlEncode(new Uint8Array(signature));
      const signedJWT = `${unsignedJWT}.${signatureBase64}`;
  
      // Obtain access token
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: signedJWT,
        }),
      });
  
      if (!response.ok) {
        console.error("Failed to obtain Google access token:", await response.text());
        return null;
      }
  
      const data = await response.json();
      return data.access_token;
    } catch (error) {
      console.error("Error obtaining Google access token:", error);
      return null;
    }
  }
  
/**
 * Imports an RS256 private key from a PEM-formatted string.
 *
 * @param pem - The PEM-formatted private key string.
 * @returns A CryptoKey object representing the imported key.
 */
async function importRS256PrivateKey(pem: string): Promise<CryptoKey> {
    // Remove PEM headers and footers
    const pemHeader = "-----BEGIN PRIVATE KEY-----";
    const pemFooter = "-----END PRIVATE KEY-----";
    const pemContents = pem
      .replace(pemHeader, "")
      .replace(pemFooter, "")
      .replace(/\s+/g, ""); // Remove all whitespace
  
    // Decode base64 to binary
    const binaryDerString = atob(pemContents);
    const binaryDer = new Uint8Array(binaryDerString.length);
    for (let i = 0; i < binaryDerString.length; i++) {
      binaryDer[i] = binaryDerString.charCodeAt(i);
    }
  
    // Import the key using SubtleCrypto
    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      binaryDer.buffer,
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
      },
      false,
      ["sign"]
    );
  
    return cryptoKey;
  }
  
/**
 * Helper function to perform Base64 URL encoding.
 *
 * @param input - The string or Uint8Array to encode.
 * @returns A Base64 URL-encoded string.
 */
function base64UrlEncode(input: string | Uint8Array): string {
    let str: string;
    if (typeof input === "string") {
      str = btoa(input);
    } else {
      str = btoa(String.fromCharCode(...input));
    }
    return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  
// Define TypeScript interfaces for the API responses
interface TrackRelease {
    name?: string;
    versionCodes?: string[];
    status?: string;
    releaseNotes?: ReleaseNote[];
  }
  
  interface ReleaseNote {
    language?: string;
    text?: string;
  }
  
  interface Track {
    track: string;
    releases: TrackRelease[];
  }
  
  interface AppEdit {
    id: string;
    expiryTimeSeconds: string;
  }
  
  // Function to fetch the latest Google Play version from the production track
  export async function getGooglePlayVersion(): Promise<string | null> {
    const packageName = Deno.env.get("GOOGLE_PLAY_PACKAGE_NAME");
  
    if (!packageName) {
      console.error("Google Play package name is not set.");
      return null;
    }
  
    const accessToken = await getGoogleAccessToken();
  
    if (!accessToken) {
      return null;
    }
  
    try {
      // Create a new app edit
      const editResponse = await fetch(
        `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/edits`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        }
      );
  
      if (!editResponse.ok) {
        console.error("Failed to create app edit:", await editResponse.text());
        return null;
      }
  
      const editData: AppEdit = await editResponse.json();
      const editId = editData.id;
  
      // Fetch the track details within the edit
      const trackResponse = await fetch(
        `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/edits/${editId}/tracks/production`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );
  
      if (!trackResponse.ok) {
        console.error("Failed to fetch track details:", await trackResponse.text());
        return null;
      }
  
      const trackData: Track = await trackResponse.json();
  
      if (
        !trackData.releases ||
        !Array.isArray(trackData.releases) ||
        trackData.releases.length === 0
      ) {
        console.log("No releases found in production track.");
        return null;
      }
  
      // Assuming the first release is the latest
      const latestRelease = trackData.releases[0];
  
      // Extract the version codes
      const versionCodes = latestRelease.versionCodes;
  
      if (!versionCodes || versionCodes.length === 0) {
        console.error("No version codes found in the latest release.");
        return null;
      }
  
      // Get the highest version code
      const latestVersionCode = Math.max(...versionCodes.map(Number));
  
      // Delete the edit to clean up
      await fetch(
        `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/edits/${editId}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );
  
      // Return the latest version code as string
      return latestVersionCode.toString();
    } catch (error) {
      console.error("Error fetching Google Play version:", error);
      return null;
    }
  }  