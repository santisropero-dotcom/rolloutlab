export type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_TRANSITION"
  | "STALE_METRICS"
  | "GATE_BLOCKED"
  | "VALIDATION_FAILED";

/** An error that maps directly to an HTTP response with a stable code. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    /** Extra machine-readable context, sent as `error.details`. */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
