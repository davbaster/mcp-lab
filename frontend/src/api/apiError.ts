/**
 * Turns any failed API call into one `ApiError`: a `code`, a `message`, the HTTP `status` and the
 * parsed `Retry-After`. Pages show `message` and branch on `code`; nobody parses a failure by hand.
 *
 * Two ways to call it, with the client from `./client`:
 *
 *   const { error, response } = await api.POST("/api/auth/login", { body });
 *   if (!response.ok) { const failure = toApiError(error, response); ... }
 *
 *   try { await api.GET("/api/health"); } catch (e) { const failure = toApiError(e); ... }
 *
 * Only the server's `{ "error": { "code", "message" } }` body is passed through. Anything else
 * (an HTML error page, plain text, an empty body, malformed or unexpected JSON, a thrown error)
 * becomes a fixed client code with a fixed message, so no text from a response, a thrown error
 * or a header ever reaches the screen. The helper reads only `status` and `Retry-After` from the
 * response, never its body, and has no state, logging or network access.
 */

/** The three codes this helper adds; every other code comes from the server. */
export const NETWORK_ERROR_MESSAGE = "Could not reach the server. Check your connection and try again.";
export const UNEXPECTED_RESPONSE_MESSAGE = "Something went wrong. Please try again.";
export const ABORTED_MESSAGE = "The request was cancelled.";

export interface ApiError {
  /** Server code, or `network_error`, `unexpected_response` or `aborted`. */
  code: string;
  /** Server message, or one fixed generic message. */
  message: string;
  /** HTTP status; null when there was no response. */
  status: number | null;
  /** Whole seconds from `Retry-After`; null when absent or invalid. */
  retryAfter: number | null;
}

type ResponseLike = Pick<Response, "status" | "headers">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** The server's code and message when `value` is exactly the shared error shape, else null. */
function sharedShape(value: unknown): { code: string; message: string } | null {
  if (!isRecord(value)) return null;
  const detail = value.error;
  if (!isRecord(detail)) return null;
  if (!isNonBlankString(detail.code) || !isNonBlankString(detail.message)) return null;
  return { code: detail.code, message: detail.message };
}

function readStatus(response: ResponseLike | null | undefined): number | null {
  const status: unknown = response?.status;
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}

/** Digits only, at least 1, a safe integer: the delay-seconds form. HTTP dates give null. */
function readRetryAfter(response: ResponseLike | null | undefined): number | null {
  const value: unknown = response?.headers?.get("Retry-After");
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 1 ? seconds : null;
}

/** By `name`, not `instanceof`: jsdom and Node have different `TypeError` and `DOMException`. */
function thrownName(failure: unknown): string | null {
  if (typeof failure !== "object" || failure === null) return null;
  const name: unknown = (failure as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

function classify(failure: unknown, hasResponse: boolean): { code: string; message: string } {
  const shared = sharedShape(failure);
  if (shared) return shared;
  // With a response, `failure` is a body, never a thrown error, so a body that happens to carry
  // a `name` of "TypeError" cannot pass for a network failure.
  if (!hasResponse) {
    const name = thrownName(failure);
    if (name === "TypeError" || name === "TimeoutError") {
      return { code: "network_error", message: NETWORK_ERROR_MESSAGE };
    }
    if (name === "AbortError") return { code: "aborted", message: ABORTED_MESSAGE };
  }
  return { code: "unexpected_response", message: UNEXPECTED_RESPONSE_MESSAGE };
}

/**
 * `failure` is the `error` the client returned or the value it threw. `response` is the
 * `response` returned next to `error`; leave it out for a thrown value. Never throws, and does
 * not touch the response body.
 */
export function toApiError(failure: unknown, response?: ResponseLike | null): ApiError {
  let status: number | null = null;
  let retryAfter: number | null = null;
  try {
    status = readStatus(response);
    retryAfter = readRetryAfter(response);
  } catch {
    // A response-like object whose getters throw: report it without status and delay.
  }
  let picked: { code: string; message: string };
  try {
    picked = classify(failure, response != null);
  } catch {
    picked = { code: "unexpected_response", message: UNEXPECTED_RESPONSE_MESSAGE };
  }
  return { code: picked.code, message: picked.message, status, retryAfter };
}
