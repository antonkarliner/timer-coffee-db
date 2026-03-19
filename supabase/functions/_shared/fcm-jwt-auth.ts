/**
 * Generates a JWT token for FCM HTTP v1 API authentication
 * @param serviceAccount - Firebase service account JSON object
 * @returns JWT token string
 */
export async function generateFCMJwtToken(serviceAccount: {
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 3600; // Token valid for 1 hour

  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: serviceAccount.private_key_id,
  };

  const payload = {
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: exp,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
  };

  const encoder = new TextEncoder();
  const headerEncoded = btoa(JSON.stringify(header)).replace(/=+$/, "");
  const payloadEncoded = btoa(JSON.stringify(payload)).replace(/=+$/, "");

  const signingInput = `${headerEncoded}.${payloadEncoded}`;

  // Import the private key
  const privateKey = serviceAccount.private_key.replace(/\\n/g, "\n");

  // Convert PEM to ArrayBuffer (tolerant of extra whitespace/lines)
  const pemBody = privateKey
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\r?\n|\s+/g, "");

  if (!pemBody || /[^A-Za-z0-9+/=]/.test(pemBody)) {
    throw new Error("Invalid FIREBASE_SERVICE_ACCOUNT.private_key format");
  }

  let binaryDerString: string;
  try {
    binaryDerString = atob(pemBody);
  } catch (err) {
    throw new Error(
      "Failed to decode FIREBASE_SERVICE_ACCOUNT.private_key (base64)",
    );
  }
  const binaryDer = new Uint8Array(binaryDerString.length);
  for (let i = 0; i < binaryDerString.length; i++) {
    binaryDer[i] = binaryDerString.charCodeAt(i);
  }

  // Import the private key for signing
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );

  // Sign the JWT
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    encoder.encode(signingInput),
  );

  const signatureArray = new Uint8Array(signature);
  let signatureString = "";
  for (let i = 0; i < signatureArray.length; i++) {
    signatureString += String.fromCharCode(signatureArray[i]);
  }

  const signatureEncoded = btoa(signatureString).replace(/=+$/, "");

  return `${signingInput}.${signatureEncoded}`;
}

/**
 * Gets an OAuth2 access token for FCM API
 * @param serviceAccount - Firebase service account JSON object
 * @returns Access token string
 */
export async function getFCMAccessToken(serviceAccount: {
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
}): Promise<string> {
  const cacheKey =
    `${serviceAccount.client_email}|${serviceAccount.project_id}`;
  const now = Date.now();

  // Cache access token (valid for ~1 hour) to avoid an OAuth request per message.
  // This is safe because the Edge Function instance can reuse the token across
  // multiple FCM sends within the same runtime.
  if (cachedAccessToken && cachedAccessToken.key === cacheKey) {
    // Use a small safety window to avoid using near-expiry tokens.
    if (cachedAccessToken.expiresAtMs - 60_000 > now) {
      return cachedAccessToken.accessToken;
    }
  }

  if (inFlightToken && inFlightToken.key === cacheKey) {
    return await inFlightToken.promise;
  }

  const promise = (async () => {
    const jwtToken = await generateFCMJwtToken(serviceAccount);

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwtToken,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to get access token: ${response.status} ${errorText}`,
      );
    }

    const data = await response.json() as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) {
      throw new Error(
        "Failed to get access token: response missing access_token",
      );
    }

    const expiresInSeconds = Number.isFinite(Number(data.expires_in))
      ? Number(data.expires_in)
      : 3600;

    cachedAccessToken = {
      key: cacheKey,
      accessToken: data.access_token,
      expiresAtMs: now + expiresInSeconds * 1000,
    };

    return data.access_token;
  })();

  inFlightToken = { key: cacheKey, promise };
  try {
    return await promise;
  } finally {
    if (inFlightToken?.key === cacheKey) {
      inFlightToken = null;
    }
  }
}

type CachedAccessToken = {
  key: string;
  accessToken: string;
  expiresAtMs: number;
};

let cachedAccessToken: CachedAccessToken | null = null;
let inFlightToken: { key: string; promise: Promise<string> } | null = null;
