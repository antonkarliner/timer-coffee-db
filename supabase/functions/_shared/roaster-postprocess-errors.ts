/**
 * Typed errors for the durable roaster post-processing pipeline
 * (mirror_logo / extract_color / attach_beans / generate_embedding jobs).
 *
 * The worker classifies failures into retryable vs terminal via these types —
 * see `roaster-postprocess-worker/failure-classification.ts`. Every class here
 * maps to a stable `error_class` slug in `service.roaster_postprocess_jobs`.
 *
 * Importing this module must stay cheap and side-effect free: it is pulled in
 * by tests that must not require Supabase env vars or ImageMagick init.
 */

import { ImageFormatError } from "./image-variants.ts";

/** Source image exceeds a hard limit. TERMINAL — retrying cannot fix the source. */
export class SourceTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceTooLargeError";
  }
}

/**
 * SVG assets cannot be rasterised by the ImageMagick WASM build in use
 * (0.0.30 has no SVG delegate — it shells out to a non-existent `inkscape`
 * binary). TERMINAL: no retry will help until the WASM build changes.
 */
export class SvgRasterizationUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SvgRasterizationUnsupportedError";
  }
}

/** Upstream logo/mirror URL answered with a non-2xx HTTP status. */
export class HttpSourceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpSourceError";
    this.status = status;
  }
}

/** Fetching the source exceeded the configured timeout. RETRYABLE. */
export class SourceTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceTimeoutError";
  }
}

/** Uploading a mirror/variant object to Supabase Storage failed. RETRYABLE. */
export class StorageUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageUploadError";
  }
}

/** Destination policy rejected the source. TERMINAL — the URL needs a fix. */
export class BlockedSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedSourceError";
  }
}

/** Source URL is absent or syntactically invalid. TERMINAL. */
export class MalformedSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedSourceError";
  }
}

/** ImageMagick failed to decode the downloaded bytes. TERMINAL (broken source). */
export class ImageDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageDecodeError";
  }
}

/** A Supabase/PostgREST RPC or table operation failed. RETRYABLE. */
export class DbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbError";
  }
}

/**
 * OPENAI_API_KEY is absent from the environment. RETRYABLE — provisioning the
 * key is an operator action that fixes every queued job, and the ledger's
 * max_attempts caps the retries either way.
 */
export class EmbeddingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingConfigError";
  }
}

/**
 * The roaster has no usable canonical name, so there is nothing to embed.
 * TERMINAL — no retry can produce text from an empty name.
 */
export class EmbeddingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingInputError";
  }
}

/**
 * The provider returned a payload that is not a 384-number array. TERMINAL —
 * storing anything else would corrupt the shared 384-dim vector space.
 */
export class EmbeddingResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingResponseError";
  }
}

/**
 * Data-quality failures that need a SOURCE URL fix, not a function fix.
 * The legacy `roaster-logo-mirror` webhook suppresses the admin error email
 * for these (the existing ImageFormatError behaviour, extended to the new
 * terminal data-quality classes that share the same rationale).
 */
export function isExpectedDataQualityError(error: unknown): boolean {
  return error instanceof BlockedSourceError ||
    error instanceof ImageFormatError ||
    error instanceof SourceTooLargeError ||
    error instanceof SvgRasterizationUnsupportedError ||
    error instanceof MalformedSourceError ||
    error instanceof ImageDecodeError;
}

/** Best-effort human-readable message for any thrown value. */
export function errorToMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
