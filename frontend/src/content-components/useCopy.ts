import { useCallback, useEffect, useRef, useState } from "react";

/** How long "Copied" stays. */
const COPIED_MS = 2000;

export type CopyState = "idle" | "copied" | "failed";

export const COPY_TEXT: Record<CopyState, string> = {
  idle: "Copy",
  copied: "Copied",
  failed: "Copy failed – select the code to copy it",
};

/**
 * The state of a Copy button (#21; shared with the code blocks of lessons, #63). `copy(text)`
 * writes the text to the clipboard: "copied" for 2 seconds, then "idle", or "failed" until the next
 * press or `reset()`. `reset()` goes back to "idle" and drops any pending timer or clipboard answer.
 * Nothing changes after the component has unmounted.
 */
export function useCopy() {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | null>(null);
  // Which press of Copy (or which reset) an answer from the clipboard belongs to.
  const attempt = useRef(0);

  const stopTimer = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(
    () => () => {
      attempt.current += 1;
      stopTimer();
    },
    [stopTimer],
  );

  const reset = useCallback(() => {
    attempt.current += 1;
    stopTimer();
    setState("idle");
  }, [stopTimer]);

  const copy = useCallback(
    async (text: string) => {
      stopTimer();
      const mine = ++attempt.current;
      let result: CopyState = "copied";
      try {
        // `navigator.clipboard` is missing on an insecure page.
        await navigator.clipboard.writeText(text);
      } catch {
        result = "failed";
      }
      if (mine !== attempt.current) return;
      setState(result);
      if (result === "copied") {
        timer.current = window.setTimeout(() => {
          timer.current = null;
          setState("idle");
        }, COPIED_MS);
      }
    },
    [stopTimer],
  );

  return { state, copy, reset };
}
