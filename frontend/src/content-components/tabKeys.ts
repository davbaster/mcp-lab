import type { KeyboardEvent } from "react";

/**
 * The tab a key moves to, for the WAI-ARIA tabs pattern with automatic activation: Left and Right
 * Arrow go to the previous and next tab and wrap, Home and End go to the first and last. Up and
 * Down Arrow, every other key, and any key with Ctrl, Alt, Meta or Shift return null.
 */
export function tabForKey(event: KeyboardEvent, active: number, last: number): number | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  switch (event.key) {
    case "ArrowRight":
      return active === last ? 0 : active + 1;
    case "ArrowLeft":
      return active === 0 ? last : active - 1;
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}
