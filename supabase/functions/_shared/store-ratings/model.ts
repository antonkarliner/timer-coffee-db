export type Store = "app_store" | "google_play";
export interface Observation {
  country: string;
  status: "ok" | "unavailable";
  average_rating: number | null;
  rating_count: number | null;
  source_date: string;
}
export interface Snapshot {
  average_rating: number | null;
  rating_count: number | null;
  source_date: string;
  methodology: string;
  coverage: Record<string, unknown>;
}
export class CollectionError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export const errorCode = (error: unknown): string =>
  error instanceof CollectionError ? error.code : "collection_failed";

export async function fetchChecked(
  url: string | URL,
  init: RequestInit = {},
  timeout = 10_000,
): Promise<Response> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeout),
      redirect: "error",
    });
    if (!response.ok) {
      throw new CollectionError(`upstream_http_${response.status}`);
    }
    return response;
  } catch (error) {
    if (error instanceof CollectionError) throw error;
    throw new CollectionError("upstream_request_failed");
  }
}

export function isSourceDate(value: string, today: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && value <= today &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
}
