export async function fetchWithTimeout(
  url: string | URL,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const upstreamSignal = options.signal;
  const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) {
    abortFromUpstream();
  } else {
    upstreamSignal?.addEventListener("abort", abortFromUpstream, {
      once: true,
    });
  }
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    clearTimeout(timeoutId);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  };
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    if (!response.body) {
      finalize();
      return response;
    }
    // fetch() resolves when response headers arrive. Keep the abort timer alive
    // until the body has been fully consumed so response.json()/text() cannot
    // hang past the configured request deadline.
    const reader = response.body.getReader();
    const timedBody = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            finalize();
            streamController.close();
            return;
          }
          streamController.enqueue(value);
        } catch (error) {
          finalize();
          streamController.error(
            timedOut
              ? new Error(`Request timeout after ${timeoutMs}ms: ${url}`)
              : error,
          );
        }
      },
      async cancel(reason) {
        finalize();
        await reader.cancel(reason);
      },
    });
    return new Response(timedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    finalize();
    if (timedOut && error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timeout after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  }
}
