/** A piece of quiz text: plain, or the inside of a backtick span. */
export interface TextSegment {
  code: boolean;
  text: string;
}

/**
 * Splits quiz text at backtick spans. `a `b` c` gives "a ", code "b", " c". A backtick with no
 * partner, and an empty pair (two backticks in a row), stay in the text as typed. Nothing else is
 * interpreted: no Markdown, no HTML, no escapes.
 */
export function splitInlineCode(input: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let plain = "";
  let from = 0;

  while (from < input.length) {
    const open = input.indexOf("`", from);
    if (open === -1) break;
    const close = input.indexOf("`", open + 1);
    if (close === -1) break;
    if (close === open + 1) {
      // An empty pair is not a span.
      plain += input.slice(from, close + 1);
      from = close + 1;
      continue;
    }
    plain += input.slice(from, open);
    if (plain) segments.push({ code: false, text: plain });
    plain = "";
    segments.push({ code: true, text: input.slice(open + 1, close) });
    from = close + 1;
  }

  plain += input.slice(from);
  if (plain) segments.push({ code: false, text: plain });
  return segments;
}
