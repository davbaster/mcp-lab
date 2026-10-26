/**
 * Network stub for tests (see "Network" in _docs/testing-guidelines.md).
 *
 * `mockFetch(respond)` replaces the global `fetch` with a `vi.fn` that calls `respond` with the
 * `Request` the API client built, and returns its `Response`. Use `jsonResponse`,
 * `errorResponse` (optionally with extra headers such as `Retry-After`) and `htmlResponse` to
 * build real-shaped responses. The stub is removed after
 * every test (`vi.unstubAllGlobals`), and it works even if the client module was imported
 * first, because the shared client in `src/api/client.ts` reads the global `fetch` per call.
 *
 * Node's `Request` rejects relative URLs such as `/api/health`, which a browser resolves against
 * the page. `mockFetch` therefore also stubs `Request` with a subclass that does the same
 * (against `location.href`, which jsdom provides).
 *
 * Never mock the client's own functions (`api.GET`) and never call `fetch` directly in a test.
 */
import { afterEach, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Respond = (request: Request) => Response | Promise<Response>;

class PageRelativeRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, location.href).href : input, init);
  }
}

export function mockFetch(respond: Respond) {
  const fetchMock = vi.fn(async (request: Request) => respond(request));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("Request", PageRelativeRequest);
  return fetchMock;
}

/** Makes `fetch` reject, like an offline browser does (`TypeError: Failed to fetch`). */
export function mockNetworkError(message = "Failed to fetch") {
  return mockFetch(() => Promise.reject(new TypeError(message)));
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** An accepted request with no body, like `POST /api/feedback` answers. */
export function acceptedResponse(): Response {
  return new Response(null, { status: 202, headers: { "Cache-Control": "private, no-store" } });
}

/**
 * A response in the shared error shape `{ "error": { "code", "message" } }`. `headers` are added
 * to the JSON content type, for example `{ "Retry-After": "900" }` for a 429.
 */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>,
): Response {
  return jsonResponse({ error: { code, message } }, status, headers);
}

/** What a proxy returns when the backend is down: an HTML page, not JSON. */
export function htmlResponse(status: number, html = "<html><body><h1>Bad Gateway</h1></body></html>"): Response {
  return new Response(html, { status, headers: { "Content-Type": "text/html" } });
}
