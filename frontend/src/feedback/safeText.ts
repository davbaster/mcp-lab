/**
 * Makes a string safe to send in the feedback request. The server rejects a whole request for one
 * NUL character or one lone surrogate, and counts length in code points, so every string is
 * cleaned and cut here by code points (never by UTF-16 units, which could split an emoji).
 */

// A valid pair is kept; any other surrogate is lone. No look-behind, which older Safari lacks.
const SURROGATE = /([\uD800-\uDBFF][\uDC00-\uDFFF])|[\uD800-\uDFFF]/g;

/** The text without NUL characters, and with each lone surrogate replaced by U+FFFD. */
export function cleanText(value: string): string {
  return value.replaceAll("\u0000", "").replace(SURROGATE, (_match, pair: string | undefined) => pair ?? "�");
}

/** The number of Unicode code points, as the server counts. */
export function codePointLength(value: string): number {
  let count = 0;
  for (const _ of value) count += 1; // eslint-disable-line @typescript-eslint/no-unused-vars
  return count;
}

/** `cleanText`, then at most `max` code points. */
export function safeText(value: string, max: number): string {
  const clean = cleanText(value);
  // A string of at most `max` UTF-16 units has at most `max` code points: no need to split it.
  if (clean.length <= max) return clean;
  let end = 0;
  let count = 0;
  for (const point of clean) {
    if (count === max) break;
    end += point.length;
    count += 1;
  }
  return clean.slice(0, end);
}
