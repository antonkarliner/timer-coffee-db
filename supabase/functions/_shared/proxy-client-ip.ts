export const PROXY_CLIENT_IP_HEADER = "x-timer-client-ip";
export const PROXY_CLIENT_IP_SIGNATURE_HEADER = "x-timer-client-ip-signature";
export const PROXY_CLIENT_IP_MAX_SKEW_SECONDS = 60;

const encoder = new TextEncoder();

function importKey(secret: string, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

function message(audience: string, seconds: string, ip: string) {
  return encoder.encode(`v1\n${audience}\n${seconds}\n${ip}`);
}

export async function signProxyClientIP(
  secret: string,
  audience: string,
  ip: string,
  nowMs = Date.now(),
): Promise<string> {
  const seconds = String(Math.floor(nowMs / 1000));
  const key = await importKey(secret, "sign");
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    message(audience, seconds, ip),
  );
  const hex = Array.from(
    new Uint8Array(signature),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `v1.${seconds}.${hex}`;
}

export async function verifyProxyClientIP(
  req: Request,
  secret: string | undefined,
  audience: string,
  nowMs = Date.now(),
): Promise<string | null> {
  try {
    if (!secret) return null;
    const ip = req.headers.get(PROXY_CLIENT_IP_HEADER);
    const signature = req.headers.get(PROXY_CLIENT_IP_SIGNATURE_HEADER);
    if (
      !ip || ip !== ip.trim() || ip.length > 45 ||
      !/^[0-9A-Fa-f:.]+$/.test(ip) || !/[.:]/.test(ip) || !signature
    ) return null;
    const match = /^v1\.([0-9]+)\.([0-9A-Fa-f]{64})$/.exec(signature);
    if (!match) return null;
    const seconds = Number(match[1]);
    if (
      !Number.isSafeInteger(seconds) || !Number.isFinite(nowMs) ||
      Math.abs(Math.floor(nowMs / 1000) - seconds) >
        PROXY_CLIENT_IP_MAX_SKEW_SECONDS
    ) return null;
    const bytes = new Uint8Array(32);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(match[2].slice(i * 2, i * 2 + 2), 16);
    }
    const key = await importKey(secret, "verify");
    return await crypto.subtle.verify(
        "HMAC",
        key,
        bytes,
        message(audience, match[1], ip),
      )
      ? ip
      : null;
  } catch {
    return null;
  }
}
