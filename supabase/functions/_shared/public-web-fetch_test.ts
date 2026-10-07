import {
  BlockedDestinationError,
  checkFetchableUrl,
  fetchPublicWeb,
  isPublicIpAddress,
  type PublicWebDeps,
  type PublicWebOptions,
  resolvePublicAddresses,
  ResponseTooLargeError,
} from "./public-web-fetch.ts";

function assert(ok: unknown, message = "assertion failed"): asserts ok {
  if (!ok) throw new Error(message);
}
async function rejects(
  fn: () => unknown,
  kind: new (...args: never[]) => Error = Error,
) {
  try {
    await fn();
  } catch (error) {
    assert(error instanceof kind, `Unexpected error: ${error}`);
    return error;
  }
  throw new Error("Expected rejection");
}
const encoder = new TextEncoder();
class FakeConn {
  closed = false;
  request = "";
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  async read(buffer: Uint8Array) {
    if (this.closed) throw new Error("closed");
    if (this.offset === this.bytes.length) return null;
    const n = Math.min(buffer.length, 17, this.bytes.length - this.offset);
    buffer.set(this.bytes.subarray(this.offset, this.offset + n));
    this.offset += n;
    return n;
  }
  async write(bytes: Uint8Array) {
    this.request += new TextDecoder().decode(bytes);
    return bytes.length;
  }
  close() {
    this.closed = true;
  }
}
function world(
  responses: Array<string | Uint8Array>,
  dns?: PublicWebDeps["resolveDns"],
) {
  const connections: FakeConn[] = [];
  const pinned: string[] = [];
  const tls: string[] = [];
  const deps: PublicWebDeps = {
    resolveDns: dns ??
      ((_host, type) => Promise.resolve(type === "A" ? ["93.184.216.34"] : [])),
    connect: ({ hostname }) => {
      pinned.push(hostname);
      const bytes = responses[connections.length];
      assert(bytes !== undefined, "unexpected connection");
      const conn = new FakeConn(
        typeof bytes === "string" ? encoder.encode(bytes) : bytes,
      );
      connections.push(conn);
      return Promise.resolve(conn as unknown as Deno.Conn);
    },
    startTls: (conn, { hostname, alpnProtocols }) => {
      assert(alpnProtocols.join() === "http/1.1");
      tls.push(hostname);
      return Promise.resolve(conn);
    },
    now: () => 0,
  };
  return { deps, connections, pinned, tls };
}
const opts: PublicWebOptions = { timeoutMs: 1000, maxBytes: 100 };
const ok = "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello";

Deno.test("every specified reserved IP range, mapped/NAT64 policy and robust parsing", () => {
  const blocked = [
    "0.1.2.3",
    "10.0.0.1",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.1.1",
    "198.19.1.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "64:ff9b:1::1",
    "100::1",
    "2001::1",
    "2001:1ff::1",
    "2001:db8::1",
    "2002:0808:0808::1",
    "fc00::1",
    "FDFF::1",
    "fe80::1",
    "febf::1",
    "fec0::1",
    "feff::1",
    "ff00::1",
    "ffff::1",
    "::ffff:127.0.0.1",
    "::FFFF:c0a8:0101",
    "64:ff9b::10.0.0.1",
    "64:ff9b::c000:201",
    "bad",
    "8.8.8.999",
    "01.2.3.4",
    "1::2::3",
    "::1%lo0",
    "FE80::1%eth0",
    "1:2:3:4:5:6:7",
    "1:2:3:4:5:6:7:8:9",
    "::::",
    "",
  ];
  for (const address of blocked) assert(!isPublicIpAddress(address), address);
  for (
    const address of [
      "8.8.8.8",
      "93.184.216.34",
      "100.63.255.255",
      "100.128.0.0",
      "172.15.0.1",
      "172.32.0.1",
      "2001:4860:4860::8888",
      "2606:4700:4700::1111",
      "::ffff:8.8.8.8",
      "64:ff9b::808:808",
      "2606:4700:0:0:0:0:0:1111",
    ]
  ) {
    assert(isPublicIpAddress(address), address);
  }
});

Deno.test("URL scheme, credentials, ports, local suffixes and IP literals", async () => {
  for (
    const url of [
      "ftp://example.com",
      "https://user:pass@example.com",
      "http://example.com:8080",
      "http://localhost",
      "http://sub.localhost",
      "http://x.internal",
      "http://x.local",
      "http://x.home.arpa",
      "http://x.internal.",
      "http://127.0.0.1",
      "http://[::1]",
      "http://[fe80::1%25lo0]",
      "no url",
    ]
  ) {
    await rejects(() => checkFetchableUrl(url), BlockedDestinationError);
  }
  for (
    const url of [
      "http://8.8.8.8",
      "https://[2606:4700::1111]",
      "https://example.com:80",
      "http://example.com:443",
    ]
  ) assert(checkFetchableUrl(url));
});

Deno.test("DNS private A, mixed public A/private AAAA, failure and single-family success", async () => {
  for (
    const dns of [
      () => Promise.resolve(["10.0.0.1"]),
      (_: string, type: "A" | "AAAA") =>
        Promise.resolve(type === "A" ? ["8.8.8.8"] : ["::1"]),
      () => Promise.reject(new Error("dns failed")),
      () => Promise.resolve([]),
    ]
  ) {
    const w = world([], dns);
    await rejects(
      () => fetchPublicWeb("https://example.com", opts, w.deps),
      BlockedDestinationError,
    );
    assert(w.pinned.length === 0);
  }
  const w = world(
    [],
    (_, type) =>
      type === "AAAA"
        ? Promise.reject(new Error("no AAAA"))
        : Promise.resolve(["8.8.8.8"]),
  );
  assert(
    (await resolvePublicAddresses("example.com", w.deps))[0] === "8.8.8.8",
  );
  assert(
    (await resolvePublicAddresses("[2606:4700::1111]", w.deps))[0] ===
      "2606:4700::1111",
  );
});

Deno.test("TLS uses original hostname, connection is pinned, unsafe caller headers dropped", async () => {
  const w = world([ok]);
  const result = await fetchPublicWeb("https://example.com/path?q=1", {
    ...opts,
    headers: {
      Host: "evil",
      Connection: "keep-alive",
      "Content-Length": "100",
      "Transfer-Encoding": "chunked",
      "Accept-Encoding": "gzip",
      "User-Agent": "timer",
    },
  }, w.deps);
  assert(await result.response.text() === "hello");
  assert(w.pinned[0] === "93.184.216.34" && w.tls[0] === "example.com");
  const request = w.connections[0].request.toLowerCase();
  assert(request.startsWith("get /path?q=1 http/1.1\r\n"));
  assert(
    request.includes("host: example.com\r\n") &&
      request.includes("accept-encoding: identity\r\n"),
  );
  assert(
    !request.includes("evil") && !request.includes("content-length") &&
      !request.includes("transfer-encoding"),
  );
  assert(w.connections.every((c) => c.closed));
});

Deno.test("public IP literal connects without DNS and uses non-default port in Host", async () => {
  const w = world([ok], () => {
    throw new Error("must not resolve literals");
  });
  await fetchPublicWeb("http://8.8.8.8:443", opts, w.deps);
  assert(w.pinned[0] === "8.8.8.8");
  assert(w.connections[0].request.includes("host: 8.8.8.8:443"));
});

Deno.test("redirect to private destination blocked before connect", async () => {
  const w = world(
    ["HTTP/1.1 302 Found\r\nLocation: http://private.example/\r\n\r\n"],
    (host, type) =>
      Promise.resolve(
        type === "AAAA"
          ? []
          : [host === "private.example" ? "169.254.169.254" : "8.8.8.8"],
      ),
  );
  await rejects(
    () => fetchPublicWeb("https://example.com", opts, w.deps),
    BlockedDestinationError,
  );
  assert(w.pinned.length === 1 && w.connections[0].closed);
});

Deno.test("relative redirects, 303 switches HEAD to GET", async () => {
  const w = world(["HTTP/1.1 303 See Other\r\nLocation: /next\r\n\r\n", ok]);
  const result = await fetchPublicWeb("https://example.com/start", {
    ...opts,
    method: "HEAD",
  }, w.deps);
  assert(
    result.finalUrl === "https://example.com/next" && result.redirects === 1,
  );
  assert(
    w.connections[0].request.startsWith("HEAD ") &&
      w.connections[1].request.startsWith("GET /next"),
  );
  assert(await result.response.text() === "hello");
  assert(w.connections.every((c) => c.closed));
});

Deno.test("redirect loops and redirect limit close every connection", async () => {
  for (
    const [responses, limits] of [
      [["HTTP/1.1 301 Moved\r\nLocation: /\r\n\r\n"], {}],
      [[
        "HTTP/1.1 307 Moved\r\nLocation: /2\r\n\r\n",
        "HTTP/1.1 308 Moved\r\nLocation: /3\r\n\r\n",
      ], { maxRedirects: 1 }],
    ] as const
  ) {
    const w = world([...responses]);
    await rejects(() =>
      fetchPublicWeb("https://example.com/", { ...opts, ...limits }, w.deps)
    );
    assert(w.connections.every((c) => c.closed));
  }
});

Deno.test("chunked with trailers, content-length, EOF, and informational headers", async () => {
  for (
    const response of [
      ok,
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhe\r\n3;ext=yes\r\nllo\r\n0\r\nX-Trailer: yes\r\n\r\n",
      "HTTP/1.1 200 OK\r\n\r\nhello",
      "HTTP/1.1 103 Early Hints\r\nLink: </style.css>\r\n\r\n" + ok,
    ]
  ) {
    const w = world([response]);
    const result = await fetchPublicWeb("http://example.com", opts, w.deps);
    assert(await result.response.text() === "hello");
    assert(!result.truncated && w.connections[0].closed);
  }
});

Deno.test("decoded size capped: truncate versus error and exact limit", async () => {
  for (
    const framing of [
      "Content-Length: 5\r\n",
      "",
      "Transfer-Encoding: chunked\r\n",
    ]
  ) {
    const response = `HTTP/1.1 200 OK\r\n${framing}\r\n` +
      (framing.startsWith("Transfer") ? "5\r\nhello\r\n0\r\n\r\n" : "hello");
    for (const onBytesExceeded of ["truncate", "error"] as const) {
      const w = world([response]);
      if (onBytesExceeded === "error") {
        await rejects(() =>
          fetchPublicWeb("http://example.com", {
            ...opts,
            maxBytes: 3,
            onBytesExceeded,
          }, w.deps), ResponseTooLargeError);
      } else {
        const r = await fetchPublicWeb("http://example.com", {
          ...opts,
          maxBytes: 3,
        }, w.deps);
        assert(r.truncated && await r.response.text() === "hel");
      }
      assert(w.connections[0].closed);
    }
  }
  const w = world([ok]);
  assert(
    !(await fetchPublicWeb(
      "http://example.com",
      { ...opts, maxBytes: 5 },
      w.deps,
    )).truncated,
  );
});

Deno.test("gzip and deflate decompression with decompressed-byte cap", async () => {
  for (const encoding of ["gzip", "deflate"] as const) {
    const compressed = new Uint8Array(
      await new Response(
        new Blob(["hello".repeat(100)]).stream().pipeThrough(
          new CompressionStream(encoding),
        ),
      ).arrayBuffer(),
    );
    const head = encoder.encode(
      `HTTP/1.1 200 OK\r\nContent-Encoding: ${encoding}\r\nContent-Length: ${compressed.length}\r\n\r\n`,
    );
    const response = new Uint8Array(head.length + compressed.length);
    response.set(head);
    response.set(compressed, head.length);
    for (const mode of ["truncate", "error"] as const) {
      const w = world([response]);
      if (mode === "error") {
        await rejects(() =>
          fetchPublicWeb("https://example.com", {
            ...opts,
            onBytesExceeded: mode,
          }, w.deps), ResponseTooLargeError);
      } else {
        const r = await fetchPublicWeb("https://example.com", opts, w.deps);
        assert(r.truncated && (await r.response.text()) === "hello".repeat(20));
        assert(!r.response.headers.has("content-encoding"));
      }
      assert(w.connections[0].closed);
    }
  }
});

Deno.test("HEAD, 204 and 304 never read a body", async () => {
  for (
    const [method, status] of [["HEAD", 200], ["GET", 204], [
      "GET",
      304,
    ]] as const
  ) {
    const w = world([`HTTP/1.1 ${status} OK\r\nContent-Length: 500\r\n\r\n`]);
    const result = await fetchPublicWeb("http://example.com", {
      ...opts,
      method,
    }, w.deps);
    assert(await result.response.text() === "" && w.connections[0].closed);
  }
});

Deno.test("CR/LF header injection rejected before connecting", async () => {
  for (
    const headers of [{ "X-Test\r\nInjected": "yes" }, {
      "X-Test": "yes\r\nInjected: yes",
    }] as Record<string, string>[]
  ) {
    const w = world([]);
    await rejects(() =>
      fetchPublicWeb("http://example.com", { ...opts, headers }, w.deps)
    );
    assert(w.pinned.length === 0);
  }
});

Deno.test("malformed framing, unsupported encoding and oversized headers close connections", async () => {
  for (
    const response of [
      "garbage\r\n",
      "HTTP/1.1 200 OK\r\nX: " + "a".repeat(65536) + "\r\n\r\n",
      "HTTP/1.1 200 OK\r\nContent-Encoding: br\r\n\r\n",
      "HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\nx",
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nz\r\nx",
    ]
  ) {
    const w = world([response]);
    await rejects(() => fetchPublicWeb("http://example.com", opts, w.deps));
    assert(w.connections[0].closed);
  }
});

Deno.test("overall deadline spans redirects and closes on timeout", async () => {
  const w = world(["HTTP/1.1 302 Found\r\nLocation: /next\r\n\r\n"]);
  let now = 0;
  w.deps.now = () => now;
  let dnsHops = 0;
  w.deps.resolveDns = (_host, type) => {
    if (type === "A" && ++dnsHops === 2) now = 1001;
    return Promise.resolve(type === "A" ? ["8.8.8.8"] : []);
  };
  const error = await rejects(() =>
    fetchPublicWeb("http://example.com", opts, w.deps)
  );
  assert(
    error.message.startsWith("Request timeout after ") &&
      w.connections[0].closed,
  );
  let closed = false;
  let rejectRead: (error: Error) => void = () => {};
  w.deps.now = () => 0;
  w.deps.connect = () =>
    Promise.resolve({
      read: () =>
        new Promise((_, reject) => {
          rejectRead = reject;
        }),
      write: (bytes: Uint8Array) => Promise.resolve(bytes.length),
      close: () => {
        closed = true;
        rejectRead(new Error("closed"));
      },
    } as unknown as Deno.Conn);
  const timed = await rejects(() =>
    fetchPublicWeb("http://example.com", { ...opts, timeoutMs: 10 }, w.deps)
  );
  assert(timed.message.startsWith("Request timeout after ") && closed);
});

Deno.test("TLS and final-header guard failures close the pinned socket", async () => {
  const w = world([ok]);
  w.deps.startTls = () => Promise.reject(new Error("TLS failed"));
  await rejects(() => fetchPublicWeb("https://example.com", opts, w.deps));
  assert(w.connections[0].closed);
  const next = world([ok]);
  await rejects(() =>
    fetchPublicWeb("http://example.com", {
      ...opts,
      onResponse: () => {
        throw new Error("denied headers");
      },
    }, next.deps)
  );
  assert(next.connections[0].closed);
});

Deno.test("a connection completing after the deadline is closed without a request", async () => {
  const w = world([]);
  let finishConnect: (conn: Deno.Conn) => void = () => {};
  w.deps.connect = () =>
    new Promise((resolve) => {
      finishConnect = resolve;
    });
  const error = await rejects(() =>
    fetchPublicWeb("http://example.com", { ...opts, timeoutMs: 10 }, w.deps)
  );
  assert(error.message.startsWith("Request timeout after "));
  const conn = new FakeConn(encoder.encode(ok));
  finishConnect(conn as unknown as Deno.Conn);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(conn.closed && conn.request === "");
});

Deno.test("IPv6 allow-list: only global unicast outside special blocks", () => {
  for (
    const address of [
      "::127.0.0.1", // IPv4-compatible (deprecated) loopback
      "::7f00:1",
      "::ffff:0:7f00:1", // IPv4-translated loopback
      "::ffff:0:a00:1",
      "3fff::1", // documentation (RFC 9637)
      "3fff:fff::1",
      "1000::1",
      "4000::1",
    ]
  ) {
    assert(!isPublicIpAddress(address), `${address} must not be public`);
  }
  for (
    const address of [
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
      "2a00:1450:4001:80b::200e",
      "3fff:1000::1",
      "::ffff:8.8.8.8",
      "64:ff9b::808:808",
    ]
  ) {
    assert(isPublicIpAddress(address), `${address} must be public`);
  }
});

Deno.test("bare LF line endings and padded chunk sizes are accepted", async () => {
  const bareLf = world(["HTTP/1.1 200 OK\nContent-Length: 5\n\nhello"]);
  const first = await fetchPublicWeb("http://example.com/", opts, bareLf.deps);
  assert(await first.response.text() === "hello", "bare LF response body");
  const padded = world([
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" +
    "5 \r\nhello\r\n0  ;ext=1\r\n\r\n",
  ]);
  const second = await fetchPublicWeb("http://example.com/", opts, padded.deps);
  assert(await second.response.text() === "hello", "padded chunk sizes");
});

Deno.test("connect falls back to the next validated address without re-resolving", async () => {
  let lookups = 0;
  const attempted: string[] = [];
  const conn = new FakeConn(encoder.encode(ok));
  const deps: PublicWebDeps = {
    resolveDns: (_host, type) => {
      lookups += 1;
      return Promise.resolve(
        type === "A" ? ["93.184.216.34", "93.184.216.35"] : [],
      );
    },
    connect: ({ hostname }) => {
      attempted.push(hostname);
      return attempted.length === 1
        ? Promise.reject(new Error("connection refused"))
        : Promise.resolve(conn as unknown as Deno.Conn);
    },
    startTls: (c) => Promise.resolve(c),
    now: () => 0,
  };
  const result = await fetchPublicWeb("http://example.com/", opts, deps);
  assert(await result.response.text() === "hello", "body from second address");
  assert(
    attempted.join() === "93.184.216.34,93.184.216.35",
    `attempted ${attempted.join()}`,
  );
  assert(lookups === 2, "one A and one AAAA lookup only");

  const allDown: PublicWebDeps = {
    ...deps,
    connect: () => Promise.reject(new Error("unreachable")),
  };
  await rejects(() => fetchPublicWeb("http://example.com/", opts, allDown));
});
