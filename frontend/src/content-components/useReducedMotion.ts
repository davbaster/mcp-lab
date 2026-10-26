import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function query(): MediaQueryList | null {
  return typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null;
}

function subscribe(onChange: () => void): () => void {
  const list = query();
  list?.addEventListener("change", onChange);
  return () => list?.removeEventListener("change", onChange);
}

/** True while the learner asks for less motion; it follows a change of the setting. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, () => query()?.matches ?? false, () => false);
}
