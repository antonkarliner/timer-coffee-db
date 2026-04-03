export async function generateAppStoreJWT(issuerId, keyId, privateKeyEnv) {
  const privateKey = privateKeyEnv.replace(/\\n/g, "\n");
  const payload = {
    iss: issuerId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 1200,
    aud: "appstoreconnect-v1"
  };
  const encodedHeader = base64UrlEncodeJson({
    alg: "ES256",
    kid: keyId,
    typ: "JWT"
  });
  const encodedPayload = base64UrlEncodeJson(payload);
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const cryptoKey = await importES256PrivateKey(privateKey);
  // crypto.subtle.sign returns IEEE P1363 format (raw r || s) which is already JOSE format
  const signature = new Uint8Array(await crypto.subtle.sign({
    name: "ECDSA",
    hash: "SHA-256"
  }, cryptoKey, new TextEncoder().encode(unsignedToken)));
  return `${unsignedToken}.${base64UrlEncodeBytes(signature)}`;
}
async function importES256PrivateKey(pem) {
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = pem.replace(pemHeader, "").replace(pemFooter, "").replace(/\s/g, "");
  const binaryDerString = atob(pemContents);
  const binaryDer = new Uint8Array(binaryDerString.length);
  for(let index = 0; index < binaryDerString.length; index += 1){
    binaryDer[index] = binaryDerString.charCodeAt(index);
  }
  return await crypto.subtle.importKey("pkcs8", binaryDer.buffer, {
    name: "ECDSA",
    namedCurve: "P-256"
  }, false, [
    "sign"
  ]);
}
function base64UrlEncodeJson(value) {
  return base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}
function base64UrlEncodeBytes(value) {
  let binary = "";
  for (const byte of value){
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
