import { classifyFailure } from "./failure-classification.ts";
import { ImageFormatError } from "../_shared/image-variants.ts";
import {
  DbError,
  HttpSourceError,
  ImageDecodeError,
  MalformedSourceError,
  SourceTimeoutError,
  SourceTooLargeError,
  StorageUploadError,
  SvgRasterizationUnsupportedError,
} from "../_shared/roaster-postprocess-errors.ts";

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${
        JSON.stringify(actual)
      }`,
    );
  }
}

Deno.test("failure classification maps every typed error to its stable slug", () => {
  const cases: Array<[unknown, string, boolean, string]> = [
    // [error, errorClass, terminal, description]
    [
      new SourceTooLargeError(
        "source_too_large: 6543x6543 (42.8 Mpx) exceeds 16 Mpx cap — replace roaster_logo_url",
      ),
      "source_too_large",
      true,
      "pixel-cap breach is terminal",
    ],
    [
      new SvgRasterizationUnsupportedError("no SVG delegate in this build"),
      "svg_rasterization_unsupported",
      true,
      "SVG rasterisation gap is terminal",
    ],
    [
      new ImageFormatError(
        "URL returned HTML — server requires authentication or the URL has expired",
      ),
      "html_response",
      true,
      "auth-gated CDN HTML is terminal",
    ],
    [
      new ImageFormatError(
        "AVIF/HEIC format is not supported in this WASM build — use a JPEG or PNG source URL",
      ),
      "unsupported_format",
      true,
      "AVIF/HEIC is terminal",
    ],
    [
      new ImageFormatError(
        "Unsupported content-type 'image/heic' — update the source URL",
      ),
      "unsupported_format",
      true,
      "HEIC content-type is terminal",
    ],
    [
      new MalformedSourceError("Malformed or absent roaster_logo_url"),
      "malformed_url",
      true,
      "malformed source URL is terminal",
    ],
    [
      new ImageDecodeError("ImageMagick failed to decode source: garbage"),
      "decode_failed",
      true,
      "decode failure is terminal",
    ],
    [
      new HttpSourceError(404, "Failed to fetch logo: HTTP 404"),
      "http_4xx",
      true,
      "404 is terminal",
    ],
    [
      new HttpSourceError(403, "Failed to fetch logo: HTTP 403"),
      "http_4xx",
      true,
      "403 is terminal",
    ],
    [
      new HttpSourceError(500, "Failed to fetch logo: HTTP 500"),
      "http_5xx",
      false,
      "5xx is retryable",
    ],
    [
      new HttpSourceError(503, "Failed to fetch logo: HTTP 503"),
      "http_5xx",
      false,
      "503 is retryable",
    ],
    [
      new HttpSourceError(429, "Failed to fetch logo: HTTP 429"),
      "http_429",
      false,
      "429 is retryable",
    ],
    [
      new HttpSourceError(408, "Failed to fetch logo: HTTP 408"),
      "http_408",
      false,
      "408 is retryable",
    ],
    [
      new SourceTimeoutError(
        "Request timeout after 20000ms: https://src/logo.png",
      ),
      "timeout",
      false,
      "fetch timeout is retryable",
    ],
    [
      new StorageUploadError("Storage upload failed: boom"),
      "storage_upload_failed",
      false,
      "storage upload failure is retryable",
    ],
    [
      new DbError("finish_roaster_job failed: connection reset"),
      "db_error",
      false,
      "DB failure is retryable",
    ],
    [
      new TypeError("error sending request: connection refused"),
      "network_error",
      false,
      "fetch TypeError is a retryable network error",
    ],
    [
      new Error("something unexpected"),
      "unknown_error",
      false,
      "unknown errors default to retryable (max_attempts bounds the loop)",
    ],
    [
      "a thrown string",
      "unknown_error",
      false,
      "non-Error throws default to retryable",
    ],
  ];

  for (const [error, expectedClass, expectedTerminal, description] of cases) {
    const classified = classifyFailure(error);
    assertEquals(
      classified,
      { errorClass: expectedClass, terminal: expectedTerminal },
      description,
    );
  }
});
