import { toApiError, type ApiError } from "./apiError";

export type Settled<T> = { data: T } | { failure: ApiError };

/**
 * Awaits one generated-client call and returns either its data or one `ApiError`. A call failed
 * when `!response.ok` (or when it threw), never when `error` is truthy.
 */
export async function settle<T>(
  request: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<Settled<T>> {
  try {
    const { data, error, response } = await request;
    return response.ok && data ? { data } : { failure: toApiError(error, response) };
  } catch (thrown) {
    return { failure: toApiError(thrown) };
  }
}
