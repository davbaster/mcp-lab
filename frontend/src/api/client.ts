import createClient, { type Client, type ClientOptions, type Middleware } from "openapi-fetch";
import type { paths } from "./schema";

/**
 * The one place that creates the API client. Every other file imports `api` (or, in tests,
 * `createApiClient`) from here. A second `createClient` anywhere else is a lint error.
 *
 * What callers must handle: pass every failure to `toApiError` (`./apiError`), which turns it into
 * one `{ code, message, status, retryAfter }` value. A call failed when `!response.ok` (or when it
 * threw), never when `error` is truthy, because an empty error body leaves `error` as `""` or
 * `undefined`.
 * - A response the spec documents (2xx, and 4xx/5xx in the shared error shape) comes back as
 *   `{ data, response }` or `{ error, response }`, with the JSON body parsed.
 * - A 4xx/5xx whose body is not JSON (for example an HTML 502 page from the proxy) also comes
 *   back as `{ error, response }`, but `error` is the raw body text, a string.
 * - A network failure (offline, DNS, CORS) is NOT returned: the call rejects with a `TypeError`,
 *   and an aborted request rejects with a `DOMException` named `AbortError`. A 2xx whose body is
 *   not JSON rejects with a `SyntaxError`. Await the call inside try/catch.
 * - A 2xx with an empty body (204) gives `data: undefined`.
 */

/** Empty on purpose: the spec's paths already start with `/api`, and the browser sends
 * requests to the page's own origin (Vite proxy in dev, Caddy in Docker and production). */
export const API_BASE_URL = "";

export type ApiClient = Client<paths>;

/** The middleware type for `api.use`, so other files need not import `openapi-fetch`. */
export type ApiMiddleware = Middleware;

/** Creates a client. Pass options only in tests (for example a `fetch` to inspect requests). */
export function createApiClient(options: ClientOptions = {}): ApiClient {
  // No `credentials: "include"`: the browser's default (`same-origin`) sends the session
  // cookie to our own origin only.
  return createClient<paths>({ baseUrl: API_BASE_URL, ...options });
}

/**
 * openapi-fetch reads the global `fetch` once, when a client is created. If this module's
 * client were created at import time, a test that stubs `fetch` afterwards would be ignored.
 * So the default client is built on the first call that follows each use, and picks up whatever
 * the global `fetch` is at that moment. Middleware added with `api.use` is kept and applied to
 * every build.
 */
const middleware: Middleware[] = [];

function currentClient(): ApiClient {
  const client = createApiClient();
  client.use(...middleware);
  return client;
}

/** The shared client. Use `api.GET("/api/health")` and so on. */
export const api: ApiClient = new Proxy({} as ApiClient, {
  get(_target, property) {
    if (property === "use") {
      return (...added: Middleware[]) => {
        middleware.push(...added);
      };
    }
    if (property === "eject") {
      return (...removed: Middleware[]) => {
        for (const m of removed) {
          const index = middleware.indexOf(m);
          if (index !== -1) middleware.splice(index, 1);
        }
      };
    }
    return Reflect.get(currentClient(), property);
  },
});
