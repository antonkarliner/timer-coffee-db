// Offline-only replacement for monitoring.ts via the replay import map.
// No database client, buffers, timers or production writes.
export enum ErrorCategory {
  EXTERNAL_API = "external_api",
  VALIDATION = "validation",
  NETWORK = "network",
  RATE_LIMIT = "rate_limit",
}
export enum ErrorSeverity {
  MEDIUM = "medium",
  LOW = "low",
}
export function logInfo(..._args: unknown[]) {}
export function logError(...args: unknown[]) {
  console.error(String(args[0]));
}
