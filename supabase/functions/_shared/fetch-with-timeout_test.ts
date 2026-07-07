import { fetchWithTimeout } from "./fetch-with-timeout.ts";

Deno.test("fetchWithTimeout covers response body consumption", async () => {
  let port = 0;
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen(address) {
      port = address.port;
    },
  }, () => {
    let bodyTimer: number | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyTimer = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode('{"ok":true}'));
          controller.close();
        }, 200);
      },
      cancel() {
        clearTimeout(bodyTimer);
      },
    });
    return new Response(body, {
      headers: { "content-type": "application/json" },
    });
  });

  try {
    const response = await fetchWithTimeout(
      `http://127.0.0.1:${port}`,
      {},
      30,
    );
    let error: unknown;
    try {
      await response.json();
    } catch (caught) {
      error = caught;
    }
    if (!(error instanceof Error) || !error.message.includes("timeout")) {
      throw new Error(`Expected response body timeout, got: ${String(error)}`);
    }
  } finally {
    await server.shutdown();
  }
});
