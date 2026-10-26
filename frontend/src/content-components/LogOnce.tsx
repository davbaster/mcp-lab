import { useEffect, useRef } from "react";

/**
 * Logs `message` once for as long as it stays on the page. It logs in an effect, not in render,
 * and remembers that it did, so a re-render, a tab switch or StrictMode's second effect run does
 * not log it again.
 */
export function LogOnce({ level, message }: { level: "warn" | "error"; message: string }) {
  const logged = useRef(false);
  useEffect(() => {
    if (logged.current) return;
    logged.current = true;
    console[level](message);
  }, [level, message]);
  return null;
}
