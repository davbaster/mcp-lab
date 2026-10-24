// Text helpers that the code-step checks, the diff, and the ZIP share.

/** Plain code-unit order, the same on every platform (never the locale's order). */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The text of a code file as it is shown, diffed, and zipped: one leading byte order mark removed and
 * `\r\n` turned into `\n`. Nothing else changes (a lone `\r`, trailing spaces, tabs, and a missing final newline stay).
 */
export function normalizeText(text: string): string {
  return (text.startsWith("\uFEFF") ? text.slice(1) : text).replaceAll("\r\n", "\n");
}

/**
 * The lines of normalized text, each with its `\n` (the last one only when the file ends with one), so
 * that "a" and "a\n" are different lines. A final newline adds no empty last line, and "" has no lines.
 */
export function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
    lines.push(text.slice(start, end + 1));
    start = end + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}
