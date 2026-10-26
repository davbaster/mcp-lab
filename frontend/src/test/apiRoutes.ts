/**
 * Routes the stubbed network by method and path, on top of `mockFetch`. Every request is
 * recorded, so a test can check what the app sent (and how many times).
 *
 *   const api = apiRoutes({ "GET /api/auth/me": () => jsonResponse({ username: "ada_l" }) });
 *   ...
 *   expect(api.calls("POST /api/auth/login")).toHaveLength(1);
 *
 * Without an override, `GET /api/auth/me` answers 401 (a visitor) and `GET /api/courses` answers
 * an empty list. Any other request gets a 404 in the shared error shape, so a stray call fails
 * loudly instead of hanging. A handler returns a fresh `Response` each time (a body can be read
 * once).
 */
import { errorResponse, jsonResponse, mockFetch } from "./mockApi";

export interface RecordedCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  credentials: RequestCredentials;
  /** The parsed JSON body, or undefined when there was none. */
  body: unknown;
}

type Handler = (call: RecordedCall) => Response | Promise<Response>;

const DEFAULTS: Record<string, Handler> = {
  "GET /api/auth/me": () => errorResponse(401, "not_authenticated", "Sign in to continue."),
  "GET /api/courses": () => jsonResponse({ courses: [] }),
};

export function apiRoutes(overrides: Record<string, Handler> = {}) {
  const handlers = { ...DEFAULTS, ...overrides };
  const recorded: RecordedCall[] = [];

  const fetchMock = mockFetch(async (request) => {
    const text = await request.clone().text();
    const call: RecordedCall = {
      method: request.method,
      path: new URL(request.url).pathname,
      headers: Object.fromEntries(request.headers.entries()),
      credentials: request.credentials,
      body: text === "" ? undefined : JSON.parse(text),
    };
    recorded.push(call);
    const handler = handlers[`${call.method} ${call.path}`];
    return handler ? handler(call) : errorResponse(404, "not_found", `Unexpected ${call.method} ${call.path}`);
  });

  return {
    fetchMock,
    /** Every recorded call, or only those for `"POST /api/auth/login"`. */
    calls(route?: string): RecordedCall[] {
      return route ? recorded.filter((call) => `${call.method} ${call.path}` === route) : [...recorded];
    },
  };
}

/** A promise settled by hand, to hold a response back (an unanswered `/me`, a slow request). */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
