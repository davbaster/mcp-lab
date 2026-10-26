import { useEffect, useState } from "react";
import { splitLines } from "./codeLines";
import { highlight, MAX_HIGHLIGHT_CHARS, type HighlightedLines, type Language } from "./highlighter";

/**
 * The colored lines of `code`, or null while the highlighter works, when there is nothing to color
 * (no language, an empty text, a text over the size limit) and whenever it gives nothing: then the
 * caller keeps showing the plain text. An answer that is for other code or another language than
 * the current one is never returned, so a change of props never shows old colors over new text.
 * The grammar is requested when the component first renders, not before.
 */
export function useHighlighted(code: string, language: Language | null): HighlightedLines | null {
  const [done, setDone] = useState<{ code: string; language: Language; lines: HighlightedLines } | null>(null);

  useEffect(() => {
    if (language === null || code === "" || code.length > MAX_HIGHLIGHT_CHARS) return;
    let current = true;
    void highlight(code, language).then((lines) => {
      if (current && lines !== null && lines.length === splitLines(code).length) setDone({ code, language, lines });
    });
    return () => {
      current = false;
    };
  }, [code, language]);

  return done !== null && done.code === code && done.language === language ? done.lines : null;
}
