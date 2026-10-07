/** HTTP/1.1 over a validated, pinned address; fetch() must not resolve it again. */
export class BlockedDestinationError extends Error {
  constructor(readonly reason: string) {
    super(`Blocked destination: ${reason}`);
    this.name = "BlockedDestinationError";
  }
}

export class ResponseTooLargeError extends Error {
  constructor(readonly declaredLength: string | null) {
    super("Response body exceeds byte cap");
    this.name = "ResponseTooLargeError";
  }
}

function ipv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^(0|[1-9]\d{0,2})$/.test(p))) {
    return null;
  }
  const bytes = parts.map(Number);
  return bytes.every((b) => b <= 255) ? bytes : null;
}

function ipv6(address: string): number[] | null {
  if (!/^[\da-f:.]+$/i.test(address)) return null;
  if (address.includes(".")) {
    const last = address.lastIndexOf(":");
    const v4 = ipv4(address.slice(last + 1));
    if (!v4) return null;
    address = address.slice(0, last + 1) +
      ((v4[0] << 8) | v4[1]).toString(16) + ":" +
      ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((p) => !/^[\da-f]{1,4}$/i.test(p))) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  return [...left, ...Array(missing).fill("0"), ...right].map((p) =>
    parseInt(p, 16)
  );
}

export function isPublicIpAddress(address: string): boolean {
  const v4 = ipv4(address);
  if (v4) {
    const [a, b, c] = v4;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && ((b === 0 && (c === 0 || c === 2)) ||
        (b === 88 && c === 99) || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  const v6 = ipv6(address);
  if (!v6) return false;
  const [a, b, c, d, e, f, g, h] = v6;
  // IPv4-mapped (::ffff:0:0/96) and the NAT64 well-known prefix
  // (64:ff9b::/96) carry an IPv4 address: judge that address.
  if (
    (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) ||
    (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0)
  ) {
    return isPublicIpAddress(`${g >> 8}.${g & 255}.${h >> 8}.${h & 255}`);
  }
  // Allow-list: only global unicast (2000::/3) can be public. That excludes
  // ::/8 (unspecified, loopback, IPv4-compatible and IPv4-translated forms),
  // 64:ff9b:1::/48, 100::/64, fc00::/7, fe80::/10, fec0::/10 and ff00::/8.
  if ((a & 0xe000) !== 0x2000) return false;
  // Special-purpose blocks inside 2000::/3: IETF protocol assignments incl.
  // Teredo (2001::/23), documentation (2001:db8::/32, 3fff::/20), 6to4.
  return !((a === 0x2001 && b < 0x200) || (a === 0x2001 && b === 0xdb8) ||
    a === 0x2002 || (a === 0x3fff && b < 0x1000));
}

function bareHost(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

export function checkFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedDestinationError("url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedDestinationError("scheme");
  }
  if (url.username || url.password) {
    throw new BlockedDestinationError("credentials");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new BlockedDestinationError("port");
  }
  const host = bareHost(url.hostname).toLowerCase().replace(/\.$/, "");
  if (!host) throw new BlockedDestinationError("hostname");
  if (
    host === "localhost" ||
    [".localhost", ".local", ".internal", ".home.arpa"].some((s) =>
      host.endsWith(s)
    )
  ) {
    throw new BlockedDestinationError("hostname");
  }
  if ((ipv4(host) || host.includes(":")) && !isPublicIpAddress(host)) {
    throw new BlockedDestinationError("ip");
  }
  return url;
}

export interface PublicWebDeps {
  resolveDns(hostname: string, type: "A" | "AAAA"): Promise<string[]>;
  connect(options: { hostname: string; port: number }): Promise<Deno.Conn>;
  startTls(
    conn: Deno.Conn,
    options: { hostname: string; alpnProtocols: string[] },
  ): Promise<Deno.Conn>;
  now(): number;
}
const network: PublicWebDeps = {
  resolveDns: (host, type) => Deno.resolveDns(host, type),
  connect: (options) => Deno.connect(options),
  startTls: (conn, options) => Deno.startTls(conn as Deno.TcpConn, options),
  now: () => Date.now(),
};

export async function resolvePublicAddresses(
  hostname: string,
  deps: PublicWebDeps = network,
): Promise<string[]> {
  const host = bareHost(hostname);
  if (ipv4(host) || host.includes(":")) {
    if (!isPublicIpAddress(host)) throw new BlockedDestinationError("ip");
    return [host];
  }
  const results = await Promise.allSettled([
    deps.resolveDns(host, "A"),
    deps.resolveDns(host, "AAAA"),
  ]);
  const addresses = results.flatMap((r) =>
    r.status === "fulfilled" ? r.value : []
  );
  if (!addresses.length) throw new BlockedDestinationError("dns");
  if (addresses.some((a) => !isPublicIpAddress(a))) {
    throw new BlockedDestinationError("ip");
  }
  return addresses.sort((a, b) =>
    Number(a.includes(":")) - Number(b.includes(":"))
  );
}

export interface PublicWebOptions {
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  onBytesExceeded?: "truncate" | "error";
  /** Final headers guard, before downloading (e.g. logo MIME/declared size). */
  onResponse?: (response: Response) => void | Promise<void>;
}

class WireReader {
  private bytes = new Uint8Array(0);
  constructor(private conn: Deno.Conn, private checkDeadline: () => void) {}
  async take(max: number): Promise<Uint8Array | null> {
    this.checkDeadline();
    if (!this.bytes.length) {
      const buffer = new Uint8Array(16_384);
      const n = await this.conn.read(buffer);
      this.checkDeadline();
      if (n === null) return null;
      if (!n) return this.take(max);
      this.bytes = buffer.subarray(0, n);
    }
    const out = this.bytes.subarray(0, max);
    this.bytes = this.bytes.subarray(out.length);
    return out;
  }
  async line(budget: { remaining: number }): Promise<string> {
    const bytes: number[] = [];
    for (;;) {
      const byte = await this.take(1);
      if (!byte) throw new Error("Unexpected HTTP EOF");
      if (--budget.remaining < 0) throw new Error("HTTP headers exceed 64 KiB");
      bytes.push(byte[0]);
      if (byte[0] === 10) {
        // RFC 9112 2.2: a recipient MAY accept a bare LF as a line terminator.
        const end = bytes.at(-2) === 13 ? -2 : -1;
        return new TextDecoder().decode(new Uint8Array(bytes.slice(0, end)));
      }
    }
  }
  async *body(headers: Headers): AsyncGenerator<Uint8Array> {
    const transfer = headers.get("transfer-encoding");
    if (transfer && transfer.toLowerCase() !== "chunked") {
      throw new Error("Unsupported transfer encoding");
    }
    if (transfer) {
      for (;;) {
        const budget = { remaining: 65_536 };
        const line = await this.line(budget);
        const size = line.split(";")[0].trim();
        if (!/^[\da-f]+$/i.test(size)) {
          throw new Error("Invalid HTTP chunk size");
        }
        let remaining = parseInt(size, 16);
        if (!Number.isSafeInteger(remaining)) {
          throw new Error("Invalid HTTP chunk size");
        }
        if (remaining === 0) {
          while (await this.line(budget)) { /* bounded trailers */ }
          return;
        }
        while (remaining) {
          const bytes = await this.take(remaining);
          if (!bytes) throw new Error("Unexpected HTTP EOF");
          remaining -= bytes.length;
          yield bytes;
        }
        if (await this.line(budget) !== "") {
          throw new Error("Invalid HTTP chunk terminator");
        }
      }
    }
    const length = headers.get("content-length");
    if (length !== null && !/^\d+$/.test(length)) {
      throw new Error("Invalid content-length");
    }
    let remaining = length === null ? Infinity : Number(length);
    if (length !== null && !Number.isSafeInteger(remaining)) {
      throw new Error("Invalid content-length");
    }
    while (remaining > 0) {
      const bytes = await this.take(remaining);
      if (!bytes) {
        if (length !== null) throw new Error("Unexpected HTTP EOF");
        return;
      }
      remaining -= bytes.length;
      yield bytes;
    }
  }
}

export async function fetchPublicWeb(
  rawUrl: string,
  options: PublicWebOptions,
  deps: PublicWebDeps = network,
): Promise<{
  response: Response;
  finalUrl: string;
  redirects: number;
  truncated: boolean;
}> {
  if (
    !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 ||
    !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0
  ) throw new Error("Invalid fetch limits");
  const deadline = deps.now() + options.timeoutMs;
  let conn: Deno.Conn | undefined;
  let expired = false;
  const close = () => {
    try {
      conn?.close();
    } catch { /* already closed */ }
    conn = undefined;
  };
  const timeoutError = () =>
    new Error(`Request timeout after ${options.timeoutMs}ms`);
  const checkDeadline = () => {
    if (expired || deps.now() >= deadline) throw timeoutError();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      close();
      reject(timeoutError());
    }, options.timeoutMs);
  });
  const run = async () => {
    let url = checkFetchableUrl(rawUrl);
    let method = options.method ?? "GET";
    const seen = new Set<string>();
    for (let redirects = 0;; redirects++) {
      if (expired || deps.now() >= deadline) throw timeoutError();
      url = checkFetchableUrl(url.href);
      url.hash = "";
      if (seen.has(url.href)) throw new Error("HTTP redirect loop");
      seen.add(url.href);
      // The same defaults native fetch sends; some sites refuse requests
      // without them (seen live: a 403 that became 200). Callers override.
      const headers = new Headers({ "Accept": "*/*", "Accept-Language": "*" });
      for (const [name, value] of Object.entries(options.headers ?? {})) {
        if (/[\r\n]/.test(name + value)) throw new Error("Invalid HTTP header");
        if (
          [
            "host",
            "connection",
            "content-length",
            "transfer-encoding",
            "accept-encoding",
          ].includes(name.toLowerCase())
        ) continue;
        headers.set(name, value);
      }
      const addresses = await resolvePublicAddresses(url.hostname, deps);
      if (expired || deps.now() >= deadline) throw timeoutError();
      // Every address was validated above; try them in order, like fetch's
      // own connection fallback, without resolving the name again.
      const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
      let tcp: Deno.Conn | undefined;
      let connectError: unknown;
      for (const address of addresses) {
        if (expired || deps.now() >= deadline) throw timeoutError();
        try {
          tcp = await deps.connect({ hostname: address, port });
          break;
        } catch (error) {
          connectError = error;
        }
      }
      if (!tcp) throw connectError;
      if (expired) {
        tcp.close();
        throw timeoutError();
      }
      conn = tcp;
      checkDeadline();
      if (url.protocol === "https:") {
        const tls = await deps.startTls(tcp, {
          hostname: bareHost(url.hostname),
          alpnProtocols: ["http/1.1"],
        });
        if (expired) {
          tls.close();
          throw timeoutError();
        }
        conn = tls;
        checkDeadline();
      }
      headers.set("Host", url.host);
      headers.set("Accept-Encoding", "identity");
      headers.set("Connection", "close");
      const request = new TextEncoder().encode(
        `${method} ${url.pathname}${url.search} HTTP/1.1\r\n${
          [...headers].map(([k, v]) => `${k}: ${v}\r\n`).join("")
        }\r\n`,
      );
      let written = 0;
      while (written < request.length) {
        const n = await conn.write(request.subarray(written));
        if (n <= 0) throw new Error("HTTP write failed");
        checkDeadline();
        written += n;
      }
      const wire = new WireReader(conn, checkDeadline);
      const budget = { remaining: 65_536 };
      let status: number, statusText: string, responseHeaders: Headers;
      for (;;) {
        const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(
          await wire.line(budget),
        );
        if (!match) throw new Error("Invalid HTTP status line");
        status = Number(match[1]);
        statusText = match[2] ?? "";
        responseHeaders = new Headers();
        for (;;) {
          const line = await wire.line(budget);
          if (!line) break;
          const colon = line.indexOf(":");
          if (colon <= 0) throw new Error("Invalid HTTP header");
          responseHeaders.append(
            line.slice(0, colon),
            line.slice(colon + 1).trim(),
          );
        }
        if (status >= 200) break;
        if (status < 100 || status === 101) {
          throw new Error("Unsupported HTTP status");
        }
      }
      const location = responseHeaders.get("location");
      if ([301, 302, 303, 307, 308].includes(status) && location !== null) {
        close();
        if (redirects >= (options.maxRedirects ?? 5)) {
          throw new Error("Too many HTTP redirects");
        }
        url = checkFetchableUrl(new URL(location, url).href);
        if (status === 303) method = "GET";
        continue;
      }
      await options.onResponse?.(
        new Response(null, { status, statusText, headers: responseHeaders }),
      );
      checkDeadline();
      let total = 0, truncated = false;
      const noBody = method === "HEAD" || status === 204 || status === 304 ||
        status === 205;
      // A single bounded buffer avoids unbounded per-chunk allocation overhead.
      const bytes = new Uint8Array(noBody ? 0 : options.maxBytes);
      if (!noBody) {
        const iterator = wire.body(responseHeaders);
        let stream: ReadableStream<Uint8Array<ArrayBuffer>> =
          new ReadableStream<Uint8Array<ArrayBuffer>>({
            async pull(controller) {
              try {
                const next = await iterator.next();
                if (next.done) controller.close();
                else controller.enqueue(new Uint8Array(next.value));
              } catch (error) {
                controller.error(error);
              }
            },
            async cancel() {
              await iterator.return(undefined);
            },
          }, { highWaterMark: 0 });
        const encoding = responseHeaders.get("content-encoding")?.toLowerCase();
        if (encoding && encoding !== "identity") {
          if (encoding !== "gzip" && encoding !== "deflate") {
            throw new Error("Unsupported content encoding");
          }
          stream = stream.pipeThrough(new DecompressionStream(encoding));
        }
        const reader = stream.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            checkDeadline();
            if (done) break;
            if (total + value.length > options.maxBytes) {
              if (options.onBytesExceeded === "error") {
                throw new ResponseTooLargeError(
                  responseHeaders.get("content-length"),
                );
              }
              bytes.set(value.subarray(0, options.maxBytes - total), total);
              total = options.maxBytes;
              truncated = true;
              break;
            }
            bytes.set(value, total);
            total += value.length;
          }
        } finally {
          // Closing first unblocks any pending decompressor/source pull.
          close();
          await reader.cancel().catch(() => {});
        }
      }
      checkDeadline();
      // The returned bytes are decoded; wire framing/encoding is no longer true.
      responseHeaders.delete("transfer-encoding");
      responseHeaders.delete("content-encoding");
      return {
        response: new Response(noBody ? null : bytes.subarray(0, total), {
          status,
          statusText,
          headers: responseHeaders,
        }),
        finalUrl: url.href,
        redirects,
        truncated,
      };
    }
  };
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
    close();
  }
}
