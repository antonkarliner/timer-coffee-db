type AppStoreJWTPayload = {
  iss: string;
  iat: number;
  exp: number;
  aud: string;
};

export async function generateAppStoreJWT(
  issuerId: string,
  keyId: string,
  privateKeyEnv: string,
): Promise<string> {
  const privateKey = privateKeyEnv.replace(/\\n/g, "\n");
  const payload: AppStoreJWTPayload = {
    iss: issuerId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 1200,
    aud: "appstoreconnect-v1",
  };

  const encodedHeader = base64UrlEncodeJson({
    alg: "ES256",
    kid: keyId,
    typ: "JWT",
  });
  const encodedPayload = base64UrlEncodeJson(payload);
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const cryptoKey = await importES256PrivateKey(privateKey);
  const derSignature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      cryptoKey,
      new TextEncoder().encode(unsignedToken),
    ),
  );

  const joseSignature = derToJoseSignature(derSignature, 32);
  return `${unsignedToken}.${base64UrlEncodeBytes(joseSignature)}`;
}

async function importES256PrivateKey(pem: string): Promise<CryptoKey> {
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = pem
    .replace(pemHeader, "")
    .replace(pemFooter, "")
    .replace(/\s/g, "");

  const binaryDerString = atob(pemContents);
  const binaryDer = new Uint8Array(binaryDerString.length);
  for (let index = 0; index < binaryDerString.length; index += 1) {
    binaryDer[index] = binaryDerString.charCodeAt(index);
  }

  return await crypto.subtle.importKey(
    "pkcs8",
    binaryDer.buffer,
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    false,
    ["sign"],
  );
}

function derToJoseSignature(signature: Uint8Array, componentSize: number) {
  if (signature[0] !== 0x30) {
    throw new Error("Invalid ECDSA signature format.");
  }

  let offset = 1;
  offset += readDerLength(signature, offset).bytesRead;

  if (signature[offset] !== 0x02) {
    throw new Error("Invalid ECDSA signature R component.");
  }
  offset += 1;

  const rLengthInfo = readDerLength(signature, offset);
  offset += rLengthInfo.bytesRead;
  const r = signature.slice(offset, offset + rLengthInfo.length);
  offset += rLengthInfo.length;

  if (signature[offset] !== 0x02) {
    throw new Error("Invalid ECDSA signature S component.");
  }
  offset += 1;

  const sLengthInfo = readDerLength(signature, offset);
  offset += sLengthInfo.bytesRead;
  const s = signature.slice(offset, offset + sLengthInfo.length);

  const jose = new Uint8Array(componentSize * 2);
  jose.set(trimAndPadDerInteger(r, componentSize), 0);
  jose.set(trimAndPadDerInteger(s, componentSize), componentSize);

  return jose;
}

function trimAndPadDerInteger(value: Uint8Array, size: number) {
  let normalized = value;

  while (normalized.length > 0 && normalized[0] === 0) {
    normalized = normalized.slice(1);
  }

  if (normalized.length > size) {
    throw new Error("ECDSA signature component is too large.");
  }

  const padded = new Uint8Array(size);
  padded.set(normalized, size - normalized.length);
  return padded;
}

function readDerLength(bytes: Uint8Array, offset: number) {
  const firstByte = bytes[offset];
  if ((firstByte & 0x80) === 0) {
    return { length: firstByte, bytesRead: 1 };
  }

  const lengthBytes = firstByte & 0x7f;
  if (lengthBytes === 0 || lengthBytes > 4) {
    throw new Error("Unsupported DER length encoding.");
  }

  let length = 0;
  for (let index = 0; index < lengthBytes; index += 1) {
    length = (length << 8) | bytes[offset + 1 + index];
  }

  return {
    length,
    bytesRead: 1 + lengthBytes,
  };
}

function base64UrlEncodeJson(value: unknown) {
  return base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlEncodeBytes(value: Uint8Array) {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}
