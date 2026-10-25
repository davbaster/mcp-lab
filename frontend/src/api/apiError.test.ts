import { afterEach, describe, expect, it, vi } from "vitest";
import { errorResponse, htmlResponse, jsonResponse, mockFetch, mockNetworkError } from "../test/mockApi";
import source from "./apiError.ts?raw";
import {
  ABORTED_MESSAGE,
  NETWORK_ERROR_MESSAGE,
  UNEXPECTED_RESPONSE_MESSAGE,
  toApiError,
  type ApiError,
} from "./apiError";
import { api } from "./client";

// The literal strings from the acceptance criteria, so a changed constant fails a test.
const NETWORK_MESSAGE = "Could not reach the server. Check your connection and try again.";
const UNEXPECTED_MESSAGE = "Something went wrong. Please try again.";
const ABORTED = "The request was cancelled.";

type Respond = Parameters<typeof mockFetch>[0];

/** What a page holds after a client call: the `error` and `response`, or the thrown value. */
interface Captured {
  failure: unknown;
  response?: Response;
}

/** Calls the real generated client against a stubbed `fetch`, once, and keeps what came back. */
async function capture(respond: Respond): Promise<Captured> {
  const fetchMock = mockFetch(respond);
  let captured: Captured;
  try {
    const { error, response } = await api.GET("/api/health");
    expect(response.ok).toBe(false);
    captured = { failure: error, response };
  } catch (thrown) {
    captured = { failure: thrown };
  }
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return captured;
}

function convert({ failure, response }: Captured): ApiError {
  return toApiError(failure, response);
}

async function failureOf(respond: Respond): Promise<ApiError> {
  return convert(await capture(respond));
}

function jsonBody(body: string, status = 500): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

function textResponse(status: number, text: string): Response {
  return new Response(text, { status, headers: { "Content-Type": "text/plain" } });
}

function otherRealmError(constructorName: string): unknown {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const realm = frame.contentWindow as unknown as { eval(code: string): unknown };
  const error = realm.eval(`new ${constructorName}('x')`);
  frame.remove();
  return error;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the three client codes", () => {
  it("exports the exact messages", () => {
    expect(NETWORK_ERROR_MESSAGE).toBe(NETWORK_MESSAGE);
    expect(UNEXPECTED_RESPONSE_MESSAGE).toBe(UNEXPECTED_MESSAGE);
    expect(ABORTED_MESSAGE).toBe(ABORTED);
  });
});

describe("call styles", () => {
  it("accepts the returned error and response of a sign-in without casts", async () => {
    mockFetch(() => errorResponse(401, "invalid_credentials", "Wrong username or password."));

    const { error, response } = await api.POST("/api/auth/login", {
      body: { username: "ada", password: "pw" },
    });
    const result = response.ok ? null : toApiError(error, response);

    expect(result).toEqual({
      code: "invalid_credentials",
      message: "Wrong username or password.",
      status: 401,
      retryAfter: null,
    });
  });

  it("accepts a thrown value from a try/catch without casts", async () => {
    mockNetworkError();

    let result: ApiError | null = null;
    try {
      await api.GET("/api/health");
    } catch (e) {
      result = toApiError(e);
    }

    expect(result?.code).toBe("network_error");
  });

  it("leaves error falsy for an empty 500, so callers check response.ok", async () => {
    mockFetch(() => new Response(null, { status: 500 }));

    const { error, response } = await api.GET("/api/health");

    expect(error).toBeFalsy();
    expect(response.ok).toBe(false);
    expect(toApiError(error, response).code).toBe("unexpected_response");
  });
});

describe("shape of the result", () => {
  const inputs: [string, unknown][] = [
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["a string", "boom"],
    ["an array", [1, 2]],
    ["an Error", new Error("boom")],
    ["an empty object", {}],
  ];
  const responses: [string, Response | undefined][] = [
    ["without a response", undefined],
    ["with a response", new Response(null, { status: 500 })],
  ];

  describe.each(inputs)("given %s", (_label, input) => {
    it.each(responses)("returns a complete ApiError %s", (_name, response) => {
      const result = toApiError(input, response);

      expect(typeof result.code).toBe("string");
      expect(result.code).not.toBe("");
      expect(typeof result.message).toBe("string");
      expect(result.message).not.toBe("");
      expect(result.status).toBe(response ? 500 : null);
      expect(result.retryAfter).toBeNull();
    });
  });

  it("returns exactly the four keys", () => {
    const result = toApiError({ error: { code: "x", message: "y", details: { a: 1 } } }, new Response(null, { status: 400 }));

    expect(Object.keys(result).sort()).toEqual(["code", "message", "retryAfter", "status"]);
  });

  it("returns a new plain object and leaves a frozen failure alone", () => {
    const failure = Object.freeze({ error: Object.freeze({ code: "x", message: "y" }) });

    const result = toApiError(failure);
    result.message = "changed";

    expect(result).not.toBe(failure);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(failure).toEqual({ error: { code: "x", message: "y" } });
  });

  it("ignores extra keys inside a valid shared shape", () => {
    const result = toApiError({ error: { code: "x", message: "y", details: "DETAILS-SENTINEL-7f3a" }, trace: "t" });

    expect(JSON.stringify(result)).not.toContain("DETAILS-SENTINEL-7f3a");
    expect(result).toEqual({ code: "x", message: "y", status: null, retryAfter: null });
  });

  it("does not throw on a response whose headers throw", () => {
    const hostile = {
      status: 500,
      get headers(): Headers {
        throw new Error("no headers");
      },
    };

    expect(toApiError("", hostile).code).toBe("unexpected_response");
  });

  it("does not throw on a failure whose name getter throws", () => {
    const hostile = {
      get name(): string {
        throw new Error("no name");
      },
    };

    expect(toApiError(hostile).code).toBe("unexpected_response");
  });
});

describe("a failed response in the shared shape", () => {
  it.each([
    [404, "course_not_found", "That course does not exist."],
    [500, "internal_error", "Something went wrong on our side."],
    [401, "not_authenticated", "Please sign in."],
    [401, "invalid_credentials", "Wrong username or password."],
    [422, "validation_error", "Check the highlighted fields."],
    [409, "username_taken", "That username is taken."],
    [403, "chapter_locked", "Pass the previous quiz first."],
    [429, "too_many_attempts", "Too many sign-in attempts."],
    [429, "feedback_limit_reached", "You have sent enough feedback for today."],
    [400, "brand_new_code", "A code the helper has never heard of."],
  ])("passes the server's code and message through for %i %s", async (status, code, message) => {
    const result = await failureOf(() => errorResponse(status, code, message));

    expect(result).toEqual({ code, message, status, retryAfter: null });
  });

  it("does not trim, truncate or rewrite the message", async () => {
    const message = `  Padded <b>message</b>.\n${"long ".repeat(400)} `;

    const result = await failureOf(() => errorResponse(500, "internal_error", message));

    expect(result.message).toBe(message);
  });

  it.each([400, 405, 413, 599])("honors the shared shape on status %i", async (status) => {
    const result = await failureOf(() => errorResponse(status, "odd_status", "Odd status."));

    expect(result).toMatchObject({ code: "odd_status", message: "Odd status.", status });
  });
});

describe("a failed response that is not in the shared shape", () => {
  it.each([502, 504])("gives unexpected_response for a %i with an HTML body", async (status) => {
    const result = await failureOf(() => htmlResponse(status));

    expect(result).toEqual({ code: "unexpected_response", message: UNEXPECTED_MESSAGE, status, retryAfter: null });
  });

  it.each([502, 504])("gives unexpected_response for a %i with a plain-text body", async (status) => {
    const result = await failureOf(() => textResponse(status, "upstream timed out"));

    expect(result).toEqual({ code: "unexpected_response", message: UNEXPECTED_MESSAGE, status, retryAfter: null });
  });

  it("gives unexpected_response for a 500 with a null body", async () => {
    const result = await failureOf(() => new Response(null, { status: 500 }));

    expect(result).toEqual({ code: "unexpected_response", message: UNEXPECTED_MESSAGE, status: 500, retryAfter: null });
  });

  it("gives unexpected_response for a 502 with an empty body and Content-Length 0", async () => {
    const result = await failureOf(() => new Response("", { status: 502, headers: { "Content-Length": "0" } }));

    expect(result).toEqual({ code: "unexpected_response", message: UNEXPECTED_MESSAGE, status: 502, retryAfter: null });
  });

  it("gives unexpected_response for a 500 with an empty string body", async () => {
    const result = await failureOf(() => new Response("", { status: 500 }));

    expect(result).toEqual({ code: "unexpected_response", message: UNEXPECTED_MESSAGE, status: 500, retryAfter: null });
  });

  it("gives unexpected_response for malformed JSON with a JSON content type", async () => {
    const captured = await capture(() => jsonBody('{"error":'));

    expect(typeof captured.failure).toBe("string");
    expect(convert(captured)).toEqual({
      code: "unexpected_response",
      message: UNEXPECTED_MESSAGE,
      status: 500,
      retryAfter: null,
    });
  });

  it.each<[string, string]>([
    ["a detail string", '{ "detail": "x" }'],
    ["an error that is a string", '{ "error": "x" }'],
    ["an error without a message", '{ "error": { "code": "x" } }'],
    ["an error without a code", '{ "error": { "message": "x" } }'],
    ["a numeric code", '{ "error": { "code": 5, "message": "x" } }'],
    ["an object message", '{ "error": { "code": "x", "message": { "a": 1 } } }'],
    ["an empty code", '{ "error": { "code": "", "message": "x" } }'],
    ["a blank message", '{ "error": { "code": "x", "message": "   " } }'],
    ["a null error", '{ "error": null }'],
    ["an array as error", '{ "error": [] }'],
    ["null", "null"],
    ["an empty array", "[]"],
    ["a number", "42"],
  ])("gives unexpected_response for JSON with %s", async (_label, body) => {
    const result = await failureOf(() => jsonBody(body, 500));

    expect(result).toEqual({ code: "unexpected_response", message: UNEXPECTED_MESSAGE, status: 500, retryAfter: null });
  });

  it("gives unexpected_response for a non-shared body with status 418", async () => {
    const result = await failureOf(() => jsonResponse({ teapot: true }, 418));

    expect(result).toMatchObject({ code: "unexpected_response", status: 418 });
  });

  it("gives unexpected_response for a 304 with no body", async () => {
    const result = await failureOf(() => new Response(null, { status: 304 }));

    expect(result).toMatchObject({ code: "unexpected_response", status: 304 });
  });
});

describe("what the client throws", () => {
  it("gives network_error for a TypeError from a failed fetch", async () => {
    mockNetworkError();

    const result = await failureOf(() => Promise.reject(new TypeError("Failed to fetch")));

    expect(result).toEqual({ code: "network_error", message: NETWORK_MESSAGE, status: null, retryAfter: null });
  });

  it("gives network_error for a TimeoutError", async () => {
    const result = await failureOf(() => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")));

    expect(result).toEqual({ code: "network_error", message: NETWORK_MESSAGE, status: null, retryAfter: null });
  });

  it("gives aborted when the caller's AbortController fires", async () => {
    const controller = new AbortController();
    mockFetch(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason));
        }),
    );

    const pending = api.GET("/api/health", { signal: controller.signal });
    controller.abort();
    const failure = await pending.catch((e: unknown) => e);

    expect(toApiError(failure)).toEqual({ code: "aborted", message: ABORTED, status: null, retryAfter: null });
  });

  it("gives aborted for a DOMException named AbortError", async () => {
    const result = await failureOf(() => Promise.reject(new DOMException("aborted", "AbortError")));

    expect(result.code).toBe("aborted");
  });

  it.each([
    ["without Content-Length", {}],
    ["with Content-Length", { "Content-Length": "6" }],
  ])("gives unexpected_response with no status for a 200 HTML page %s", async (_label, headers) => {
    const captured = await capture(
      () => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html", ...headers } }),
    );
    // The 200 page makes the client throw a SyntaxError, so it never returns a response.
    expect(captured.response).toBeUndefined();
    expect(thrownName(captured.failure)).toBe("SyntaxError");

    expect(convert(captured)).toEqual({
      code: "unexpected_response",
      message: UNEXPECTED_MESSAGE,
      status: null,
      retryAfter: null,
    });
  });

  it.each<[string, unknown]>([
    ["a plain Error", new Error("boom")],
    ["a string", "boom"],
  ])("gives unexpected_response for %s", async (_label, thrown) => {
    const result = await failureOf(() => Promise.reject(thrown));

    expect(result).toEqual({ code: "unexpected_response", message: UNEXPECTED_MESSAGE, status: null, retryAfter: null });
  });

  // Not through the client: when `fetch` rejects with a falsy value, openapi-fetch swallows it
  // and fails on the missing response with its own TypeError, so the value never reaches a caller.
  it("gives unexpected_response for a thrown undefined", () => {
    expect(toApiError(undefined)).toEqual({
      code: "unexpected_response",
      message: UNEXPECTED_MESSAGE,
      status: null,
      retryAfter: null,
    });
  });

  it("recognizes a TypeError from another realm by name", async () => {
    const foreign = otherRealmError("TypeError");
    expect(foreign instanceof TypeError).toBe(false);

    const result = await failureOf(() => Promise.reject(foreign));

    expect(result.code).toBe("network_error");
  });

  it("recognizes an AbortError DOMException from another realm by name", async () => {
    const foreign = otherRealmError("DOMException");
    Object.defineProperty(foreign, "name", { value: "AbortError" });

    expect(toApiError(foreign).code).toBe("aborted");
  });

  it("does not take a response body named TypeError for a network failure", () => {
    const result = toApiError({ name: "TypeError" }, new Response(null, { status: 500 }));

    expect(result.code).toBe("unexpected_response");
  });
});

function thrownName(value: unknown): string {
  return value instanceof Error ? value.name : "";
}

describe("Retry-After", () => {
  async function retryAfterOf(value: string | undefined): Promise<number | null> {
    const headers = value === undefined ? undefined : { "Retry-After": value };
    return (await failureOf(() => errorResponse(429, "too_many_attempts", "Slow down.", headers))).retryAfter;
  }

  it.each([
    ["1", 1],
    ["59", 59],
    ["60", 60],
    ["900", 900],
  ])("reads %s as %i seconds", async (value, expected) => {
    expect(await retryAfterOf(value)).toBe(expected);
  });

  it("gives null when the header is missing", async () => {
    expect(await retryAfterOf(undefined)).toBeNull();
  });

  it.each([
    ["zero", "0"],
    ["a negative number", "-3"],
    ["a decimal", "1.5"],
    ["text", "abc"],
    ["an empty value", ""],
    ["an HTTP date", "Wed, 21 Oct 2026 07:28:00 GMT"],
    ["a number past the safe integers", "99999999999999999999"],
    ["a plus sign", "+5"],
    ["an exponent", "1e3"],
    ["a decimal that equals a whole number", "1.0"],
    ["a hexadecimal number", "0x10"],
    ["a number with spaces inside", "1 0"],
  ])("gives null for %s", async (_label, value) => {
    expect(await retryAfterOf(value)).toBeNull();
  });

  it("returns the full result for a 429 too_many_attempts with Retry-After 900", async () => {
    const result = await failureOf(() =>
      errorResponse(429, "too_many_attempts", "Too many sign-in attempts.", { "Retry-After": "900" }),
    );

    expect(result).toEqual({
      code: "too_many_attempts",
      message: "Too many sign-in attempts.",
      status: 429,
      retryAfter: 900,
    });
  });

  it("gives retryAfter null for a 429 feedback_limit_reached with no header", async () => {
    const result = await failureOf(() => errorResponse(429, "feedback_limit_reached", "Limit reached."));

    expect(result).toEqual({ code: "feedback_limit_reached", message: "Limit reached.", status: 429, retryAfter: null });
  });

  it.each([429, 503])("reads Retry-After from a %i HTML page", async (status) => {
    const result = await failureOf(
      () => new Response("<html>busy</html>", { status, headers: { "Content-Type": "text/html", "Retry-After": "30" } }),
    );

    expect(result).toEqual({ code: "unexpected_response", message: UNEXPECTED_MESSAGE, status, retryAfter: 30 });
  });

  it("reads Retry-After on a status other than 429", async () => {
    const result = await failureOf(() => errorResponse(503, "unavailable", "Back soon.", { "Retry-After": "5" }));

    expect(result.retryAfter).toBe(5);
  });
});

describe("the response is left alone", () => {
  it("does not read, clone or consume the body", async () => {
    const response = new Response("BODY-SENTINEL-7f3a", { status: 429, headers: { "Retry-After": "12" } });
    const clone = vi.spyOn(response, "clone");
    const text = vi.spyOn(response, "text");
    const json = vi.spyOn(response, "json");

    const result = toApiError("", response);

    expect(result.retryAfter).toBe(12);
    expect(response.bodyUsed).toBe(false);
    expect(clone).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(await response.text()).toBe("BODY-SENTINEL-7f3a");
  });

  it("leaves the status and Retry-After header as they were", async () => {
    const captured = await capture(() => errorResponse(429, "too_many_attempts", "Slow.", { "Retry-After": "900" }));
    const response = captured.response as Response;
    const usedBefore = response.bodyUsed;

    convert(captured);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("900");
    expect(response.bodyUsed).toBe(usedBefore);
  });

  it("asks the headers only for Retry-After", () => {
    const headers = new Headers({ "Retry-After": "7", "X-Debug": "DEBUG-SENTINEL-7f3a", "Set-Cookie": "a=b" });
    const get = vi.spyOn(headers, "get");
    const forEach = vi.spyOn(headers, "forEach");
    const entries = vi.spyOn(headers, "entries");

    const result = toApiError("", { status: 500, headers });

    expect(get.mock.calls.map(([name]) => name.toLowerCase())).toEqual(["retry-after"]);
    expect(forEach).not.toHaveBeenCalled();
    expect(entries).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("DEBUG-SENTINEL-7f3a");
  });
});

describe("nothing from a response or a thrown error is echoed", () => {
  const SENTINEL = "SENTINEL-7f3a";

  async function expectNoSentinel(respond: Respond, sentinel: string) {
    const result = await failureOf(respond);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    return result;
  }

  it("leaves out an HTML body", async () => {
    await expectNoSentinel(() => htmlResponse(502, `<html>HTML-${SENTINEL}</html>`), `HTML-${SENTINEL}`);
  });

  it("leaves out a plain-text body", async () => {
    await expectNoSentinel(() => textResponse(502, `TEXT-${SENTINEL}`), `TEXT-${SENTINEL}`);
  });

  it("leaves out malformed JSON", async () => {
    await expectNoSentinel(() => jsonBody(`{"error": "JSON-${SENTINEL}`), `JSON-${SENTINEL}`);
  });

  it("leaves out the text of a non-shared JSON body", async () => {
    await expectNoSentinel(() => jsonResponse({ detail: `DETAIL-${SENTINEL}` }, 500), `DETAIL-${SENTINEL}`);
  });

  it("leaves out the text of a body with a bad error shape", async () => {
    await expectNoSentinel(
      () => jsonResponse({ error: { code: 5, message: `SHAPE-${SENTINEL}` } }, 500),
      `SHAPE-${SENTINEL}`,
    );
  });

  it("leaves out the message of a thrown TypeError", async () => {
    await expectNoSentinel(
      () => Promise.reject(new TypeError(`TYPE-${SENTINEL} https://host/api?token=x`)),
      `TYPE-${SENTINEL}`,
    );
  });

  it("leaves out the message of a SyntaxError thrown by the client", async () => {
    const result = await expectNoSentinel(
      () => new Response(`SYNTAX-${SENTINEL} not json`, { status: 200, headers: { "Content-Type": "text/html" } }),
      `SYNTAX-${SENTINEL}`,
    );

    expect(result.code).toBe("unexpected_response");
  });

  it("leaves out the message of a SyntaxError passed in directly", () => {
    const result = toApiError(new SyntaxError(`DIRECT-${SENTINEL}`));

    expect(JSON.stringify(result)).not.toContain(`DIRECT-${SENTINEL}`);
  });

  it("leaves out an AbortError reason", () => {
    const result = toApiError(new DOMException(`ABORT-${SENTINEL}`, "AbortError"));

    expect(JSON.stringify(result)).not.toContain(`ABORT-${SENTINEL}`);
  });

  describe("signing in with a sentinel password", () => {
    const password = "PASSWORD-SENTINEL-7f3a";
    const username = "user-7f3a-unique";
    const secretHeaders = { "Set-Cookie": "session=COOKIE-SENTINEL-7f3a", "X-Debug": "HEADER-SENTINEL-7f3a" };

    async function signIn(respond: Respond): Promise<ApiError> {
      mockFetch(respond);
      try {
        const { error, response } = await api.POST("/api/auth/login", { body: { username, password } });
        return toApiError(error, response);
      } catch (thrown) {
        return toApiError(thrown);
      }
    }

    it.each<[string, Respond]>([
      ["a 502 HTML page", () => new Response("<html>502</html>", { status: 502, headers: { "Content-Type": "text/html", ...secretHeaders } })],
      ["a 429", () => errorResponse(429, "too_many_attempts", "Too many sign-in attempts.", { "Retry-After": "900", ...secretHeaders })],
      ["a network error", () => Promise.reject(new TypeError("Failed to fetch"))],
    ])("keeps the password, username and secret headers out of the result for %s", async (_label, respond) => {
      const text = JSON.stringify(await signIn(respond));

      for (const secret of [password, username, "COOKIE-SENTINEL-7f3a", "HEADER-SENTINEL-7f3a", "session="]) {
        expect(text).not.toContain(secret);
      }
    });
  });
});

describe("no side effects", () => {
  const scenarios: [string, Respond][] = [
    ["a shared-shape 404", () => errorResponse(404, "course_not_found", "No such course.")],
    ["a 429 with Retry-After", () => errorResponse(429, "too_many_attempts", "Slow.", { "Retry-After": "900" })],
    ["an HTML 502", () => htmlResponse(502)],
    ["a plain-text 504", () => textResponse(504, "timeout")],
    ["an empty 500", () => new Response(null, { status: 500 })],
    ["malformed JSON", () => jsonBody('{"error":')],
    ["a non-shared JSON body", () => jsonResponse({ detail: "x" }, 500)],
    ["a network error", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a timeout", () => Promise.reject(new DOMException("t", "TimeoutError"))],
    ["an abort", () => Promise.reject(new DOMException("a", "AbortError"))],
    ["a 200 HTML page", () => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } })],
    ["a plain Error", () => Promise.reject(new Error("boom"))],
  ];

  it("does not log, store, set cookies or call the network through any case", async () => {
    const captured: Captured[] = [];
    for (const [, respond] of scenarios) captured.push(await capture(respond));
    const direct: unknown[] = [undefined, null, 42, "text", [], new Error("e"), {}];
    const fetchMock = mockFetch(() => jsonResponse({ status: "ok" }));
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const storageSpies = [
      vi.spyOn(Storage.prototype, "getItem"),
      vi.spyOn(Storage.prototype, "setItem"),
      vi.spyOn(Storage.prototype, "removeItem"),
      vi.spyOn(Document.prototype, "cookie", "get"),
      vi.spyOn(Document.prototype, "cookie", "set"),
    ];

    for (const item of captured) convert(item);
    for (const item of direct) {
      toApiError(item);
      toApiError(item, new Response(null, { status: 500 }));
    }

    for (const spy of [...consoleSpies, ...storageSpies]) expect(spy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("has no imports, state or use of fetch, Request, XMLHttpRequest, console or storage", () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    expect(code).not.toMatch(/^\s*import\b/m);
    expect(code).not.toMatch(/\b(fetch|Request|XMLHttpRequest|console|localStorage|sessionStorage|document|window)\b/);
    expect(code).not.toMatch(/^(export )?(let|var)\s/m);
  });
});
