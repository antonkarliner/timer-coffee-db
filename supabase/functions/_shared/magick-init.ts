/**
 * Lazy singleton initialisation for the ImageMagick WASM module.
 *
 * The edge functions that use ImageMagick previously initialised it with a
 * top-level `await` at module scope. That forces every importer (including
 * `deno test` runs of colocated unit tests, which run without --allow-read)
 * to load the WASM binary. Initialising lazily on first image work keeps the
 * pure logic testable and costs nothing at cold start.
 */

import { initializeImageMagick } from "npm:@imagemagick/magick-wasm@0.0.30";

let initPromise: Promise<void> | null = null;

/**
 * Initialise ImageMagick exactly once per isolate. Subsequent calls return
 * the same promise. Must be awaited before any ImageMagick.read/write call.
 */
export function ensureImageMagickReady(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const magickWasmBytes = await Deno.readFile(
        new URL(
          "magick.wasm",
          import.meta.resolve("npm:@imagemagick/magick-wasm@0.0.30"),
        ),
      );
      await initializeImageMagick(magickWasmBytes);
    })();
    // A failed init must not be cached: allow a retry on the next call.
    initPromise.catch(() => {
      initPromise = null;
    });
  }
  return initPromise;
}
