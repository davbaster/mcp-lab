/**
 * Stand-ins for what jsdom does not have, set at the browser boundary: WebGL, the number of cores,
 * the window width and `matchMedia`. Each is put back after the test.
 */
import { afterEach, vi } from "vitest";
import { forgetWebglCheck } from "../content-components/webgl";

const restorers: (() => void)[] = [];

afterEach(() => {
  while (restorers.length > 0) restorers.pop()?.();
  forgetWebglCheck();
});

function define(target: object, key: string, value: unknown) {
  const before = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  restorers.push(() => {
    if (before) Object.defineProperty(target, key, before);
    else Reflect.deleteProperty(target, key);
  });
}

/**
 * WebGL: `contexts` are the kinds (`webgl2`, `webgl`) that `canvas.getContext` can create.
 * `created` and `lost` count the test contexts, so a test can check that each was given back.
 */
export function stubWebgl(contexts: readonly string[] = ["webgl2", "webgl"]) {
  forgetWebglCheck();
  const asked: string[] = [];
  const state = { created: 0, lost: 0 };
  const spy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((kind: string) => {
    asked.push(kind);
    if (!contexts.includes(kind)) return null;
    state.created += 1;
    return {
      getExtension: (name: string) => (name === "WEBGL_lose_context" ? { loseContext: () => (state.lost += 1) } : null),
    };
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext);
  return {
    spy,
    asked,
    get created() {
      return state.created;
    },
    get lost() {
      return state.lost;
    },
  };
}

/** `navigator.hardwareConcurrency`; `undefined` is a browser that does not say. */
export function stubCores(cores: number | undefined) {
  define(navigator, "hardwareConcurrency", cores);
}

export function stubWidth(width: number) {
  define(window, "innerWidth", width);
}

/** `matchMedia` for `prefers-reduced-motion: reduce`. `set` changes the preference and tells the listeners. */
export function stubReducedMotion(reduce: boolean) {
  let matches = reduce;
  const listeners = new Set<() => void>();
  const list = {
    get matches() {
      return matches;
    },
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  define(window, "matchMedia", vi.fn(() => list));
  return {
    listeners: () => listeners.size,
    set(next: boolean) {
      matches = next;
      listeners.forEach((listener) => listener());
    },
  };
}

/** A normal desktop: WebGL, 8 cores, 1280px wide, no preference for less motion. */
export function stubDesktop() {
  stubWebgl();
  stubCores(8);
  stubWidth(1280);
  return stubReducedMotion(false);
}
