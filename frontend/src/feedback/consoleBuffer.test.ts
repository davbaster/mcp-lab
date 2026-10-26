import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consoleErrors, installConsoleBuffer, MAX_ENTRIES, MAX_ENTRY_LENGTH, uninstallConsoleBuffer } from "./consoleBuffer";
import { mockFetch } from "../test/mockApi";

let original: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // What the page's own console.error does is stubbed; the buffer wraps the stub.
  original = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  uninstallConsoleBuffer();
  vi.restoreAllMocks();
});

function windowError(message: string, error?: unknown) {
  window.dispatchEvent(new ErrorEvent("error", { message, error }));
}

function rejection(reason: unknown) {
  window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason }));
}

describe("console buffer: console.error", () => {
  it("keeps nothing until it is installed", () => {
    console.error("before");

    installConsoleBuffer();

    expect(consoleErrors()).toEqual([]);
  });

  it("calls the original console.error with the same arguments", () => {
    installConsoleBuffer();
    const detail = { a: 1 };

    console.error("boom", detail, 3);

    expect(original).toHaveBeenCalledTimes(1);
    expect(original).toHaveBeenCalledWith("boom", detail, 3);
  });

  it("keeps a string as it is", () => {
    installConsoleBuffer();
    console.error("something broke");
    expect(consoleErrors()).toEqual(["something broke"]);
  });

  it("joins several arguments with a space", () => {
    installConsoleBuffer();
    console.error("failed to load", "lesson", 7, true, null, undefined);
    expect(consoleErrors()).toEqual(["failed to load lesson 7 true null undefined"]);
  });

  it("writes an Error as Name: message, with no stack", () => {
    installConsoleBuffer();
    console.error(new TypeError("x is not a function"));
    expect(consoleErrors()).toEqual(["TypeError: x is not a function"]);
  });

  it("does not serialise any other object: it is [object]", () => {
    installConsoleBuffer();
    console.error("body", { password: "SECRET-SENTINEL-1" }, ["SECRET-SENTINEL-2"], () => "SECRET-SENTINEL-3");
    expect(consoleErrors()).toEqual(["body [object] [object] [object]"]);
    expect(JSON.stringify(consoleErrors())).not.toContain("SECRET-SENTINEL");
  });

  it("copes with an object that throws when it is read", () => {
    installConsoleBuffer();
    const hostile = new Proxy(new Error("x"), {
      get() {
        throw new Error("no");
      },
    });

    expect(() => console.error(hostile)).not.toThrow();
    expect(original).toHaveBeenCalledTimes(1);
  });

  it("keeps only the last 10 entries, oldest first", () => {
    installConsoleBuffer();
    for (let n = 1; n <= MAX_ENTRIES + 5; n += 1) console.error(`entry ${n}`);

    const kept = consoleErrors();

    expect(kept).toHaveLength(10);
    expect(kept[0]).toBe("entry 6");
    expect(kept[9]).toBe("entry 15");
  });

  it("cuts each entry to 500 characters, by code points", () => {
    installConsoleBuffer();
    console.error("a".repeat(900));
    console.error("😀".repeat(900));

    const [plain, emoji] = consoleErrors();

    expect(plain).toHaveLength(MAX_ENTRY_LENGTH);
    expect([...emoji]).toHaveLength(MAX_ENTRY_LENGTH);
    expect(emoji).toMatch(/^(?:😀)+$/);
  });

  it("does not capture console.warn or console.log", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    installConsoleBuffer();

    console.warn("w");
    console.log("l");

    expect(consoleErrors()).toEqual([]);
    expect(warn).toHaveBeenCalledWith("w");
    expect(log).toHaveBeenCalledWith("l");
  });

  it("does not wrap twice when it is installed twice", () => {
    installConsoleBuffer();
    installConsoleBuffer();

    console.error("once");

    expect(consoleErrors()).toEqual(["once"]);
    expect(original).toHaveBeenCalledTimes(1);
  });

  it("gives back the original console.error when it is removed", () => {
    installConsoleBuffer();
    uninstallConsoleBuffer();

    expect(console.error).toBe(original);
    console.error("after");
    expect(consoleErrors()).toEqual([]);
  });
});

describe("console buffer: uncaught errors and rejections", () => {
  it("records an uncaught error as its message", () => {
    installConsoleBuffer();
    windowError("Uncaught TypeError: nope", new TypeError("nope"));
    expect(consoleErrors()).toEqual(["Uncaught TypeError: nope"]);
  });

  it("records the error itself when the event has no message", () => {
    installConsoleBuffer();
    windowError("", new RangeError("too far"));
    expect(consoleErrors()).toEqual(["RangeError: too far"]);
  });

  it("records a rejection by its reason, like console.error does", () => {
    installConsoleBuffer();
    rejection(new Error("rejected"));
    rejection("plain reason");
    rejection({ token: "SECRET-SENTINEL-4" });
    rejection(undefined);

    expect(consoleErrors()).toEqual(["Error: rejected", "plain reason", "[object]", "undefined"]);
  });

  it("does not record a failed image load, which is an error event on the image, not on the window", () => {
    installConsoleBuffer();
    const image = document.createElement("img");
    document.body.append(image);

    image.dispatchEvent(new Event("error"));
    image.remove();

    expect(consoleErrors()).toEqual([]);
  });

  it("stops listening when it is removed", () => {
    installConsoleBuffer();
    uninstallConsoleBuffer();

    windowError("late");
    rejection("late");

    expect(consoleErrors()).toEqual([]);
  });

  it("does not listen twice when it is installed twice", () => {
    installConsoleBuffer();
    installConsoleBuffer();

    windowError("once");

    expect(consoleErrors()).toEqual(["once"]);
  });
});

describe("console buffer: network", () => {
  it("makes no request by itself", () => {
    const fetchMock = mockFetch(() => new Response(null, { status: 202 }));
    installConsoleBuffer();

    console.error("e");
    windowError("w");
    rejection("r");

    expect(consoleErrors()).toHaveLength(3);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
