/**
 * The last few errors of this page, kept in memory so a feedback report can say what went wrong.
 * It is installed once when the app starts (`main.tsx`) and sends nothing by itself.
 *
 * What it keeps is text, never data: a string as is, an `Error` as "Name: message" (no stack), and
 * any other object as "[object]", so a request body or a form value that an object holds cannot
 * end up in a report.
 */
import { safeText } from "./safeText";

export const MAX_ENTRIES = 10;
export const MAX_ENTRY_LENGTH = 500;

let entries: string[] = [];
let installed: { original: typeof console.error; wrapper: typeof console.error } | null = null;

function isError(value: unknown): value is { name: unknown; message: unknown } {
  return value instanceof Error || Object.prototype.toString.call(value) === "[object Error]";
}

/** One value as a short, safe piece of text. Never throws. */
function describe(value: unknown): string {
  try {
    if (typeof value === "string") return value;
    if (isError(value)) {
      const name = typeof value.name === "string" && value.name !== "" ? value.name : "Error";
      const message = typeof value.message === "string" ? value.message : "";
      return `${name}: ${message}`;
    }
    if ((typeof value === "object" && value !== null) || typeof value === "function") return "[object]";
    return String(value);
  } catch {
    return "[object]";
  }
}

function record(text: string): void {
  entries.push(safeText(text, MAX_ENTRY_LENGTH));
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
}

function onWindowError(event: Event): void {
  try {
    // A failed image or script load is an `error` event too, but it does not bubble to the window.
    const { message, error } = event as ErrorEvent;
    if (typeof message !== "string") return;
    record(message !== "" ? message : describe(error));
  } catch {
    // The buffer must never break the page.
  }
}

function onRejection(event: Event): void {
  try {
    record(describe((event as PromiseRejectionEvent).reason));
  } catch {
    // The buffer must never break the page.
  }
}

/** Starts collecting `console.error` calls, uncaught errors, and unhandled rejections. Safe to call twice. */
export function installConsoleBuffer(): void {
  if (installed) return;
  const original = console.error;
  const wrapper: typeof console.error = function (this: unknown, ...args: unknown[]) {
    try {
      record(args.map(describe).join(" "));
    } catch {
      // The original must still run.
    }
    return Reflect.apply(original, this ?? console, args);
  };
  installed = { original, wrapper };
  console.error = wrapper;
  window.addEventListener("error", onWindowError);
  window.addEventListener("unhandledrejection", onRejection);
}

/** The entries so far, oldest first. */
export function consoleErrors(): string[] {
  return [...entries];
}

/** Stops collecting and forgets the entries. For tests: the app never uninstalls it. */
export function uninstallConsoleBuffer(): void {
  if (installed) {
    // Someone else may have wrapped console.error since; leave their wrapper alone.
    if (console.error === installed.wrapper) console.error = installed.original;
    installed = null;
  }
  window.removeEventListener("error", onWindowError);
  window.removeEventListener("unhandledrejection", onRejection);
  entries = [];
}
