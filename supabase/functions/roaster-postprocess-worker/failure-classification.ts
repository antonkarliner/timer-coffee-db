/**
 * Map pipeline errors to stable `error_class` slugs and the retry decision
 * for `service.finish_roaster_job`.
 *
 * Retryable   → state 'retry_wait', exponential backoff, retried until
 *               max_attempts (HTTP 408/429/5xx, network, timeout, storage
 *               upload failure, DB failure).
 * Terminal    → state 'failed' immediately (source_too_large,
 *               unsupported_format, html_response, malformed_url,
 *               decode_failed, svg_rasterization_unsupported, HTTP 4xx
 *               other than 408/429, roaster_missing).
 */

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

export { errorToMessage } from "../_shared/roaster-postprocess-errors.ts";

export interface ClassifiedFailure {
  errorClass: string;
  terminal: boolean;
}

export function classifyFailure(error: unknown): ClassifiedFailure {
  if (error instanceof SourceTooLargeError) {
    return { errorClass: "source_too_large", terminal: true };
  }
  if (error instanceof SvgRasterizationUnsupportedError) {
    return { errorClass: "svg_rasterization_unsupported", terminal: true };
  }
  if (error instanceof ImageFormatError) {
    // ImageFormatError covers two distinct data-quality cases; keep them
    // distinguishable in the ledger by message prefix.
    if (error.message.startsWith("URL returned HTML")) {
      return { errorClass: "html_response", terminal: true };
    }
    return { errorClass: "unsupported_format", terminal: true };
  }
  if (error instanceof MalformedSourceError) {
    return { errorClass: "malformed_url", terminal: true };
  }
  if (error instanceof ImageDecodeError) {
    return { errorClass: "decode_failed", terminal: true };
  }
  if (error instanceof HttpSourceError) {
    if (error.status === 408) {
      return { errorClass: "http_408", terminal: false };
    }
    if (error.status === 429) {
      return { errorClass: "http_429", terminal: false };
    }
    if (error.status >= 500) return { errorClass: "http_5xx", terminal: false };
    return { errorClass: "http_4xx", terminal: true };
  }
  if (error instanceof SourceTimeoutError) {
    return { errorClass: "timeout", terminal: false };
  }
  if (error instanceof StorageUploadError) {
    return { errorClass: "storage_upload_failed", terminal: false };
  }
  if (error instanceof DbError) {
    return { errorClass: "db_error", terminal: false };
  }
  // Deno's fetch rejects with TypeError on network failures (DNS, refused,
  // TLS). Anything else unrecognised is treated as transient too: the ledger
  // caps retries via max_attempts, so a mis-classification only delays.
  if (error instanceof TypeError) {
    return { errorClass: "network_error", terminal: false };
  }
  return { errorClass: "unknown_error", terminal: false };
}
