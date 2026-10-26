import { Fragment, useMemo } from "react";
import { splitLines } from "./codeLines";
import "./content.css";
import { CopyButton } from "./CopyButton";
import { languageForFence, type HighlightedToken } from "./highlighter";
import { useCopy } from "./useCopy";
import { useHighlighted } from "./useHighlighted";

/** A language name is used (as a class, and in names for screen readers) only if it looks like this. */
const CODE_LANGUAGE = /^[A-Za-z0-9_+#.-]+$/;

function usableLanguage(language: string | null | undefined): string | null {
  return typeof language === "string" && CODE_LANGUAGE.test(language) ? language : null;
}

/** The tokens of one line: plain text for default text, a `span` with the token's classes for the rest. */
export function Tokens({ tokens }: { tokens: readonly HighlightedToken[] }) {
  return (
    <>
      {tokens.map((token, position) =>
        token.className === null ? (
          token.text
        ) : (
          <span key={position} className={token.className}>
            {token.text}
          </span>
        ),
      )}
    </>
  );
}

/**
 * A block of code outside `CodeSteps`: a code fence in a lesson (#63) or the snippet of a quiz
 * question. One focusable `pre` that scrolls sideways, with the code in one `code`. It is plain
 * text first; if `language` is one the highlighter knows, the same `pre` and `code` get `span`s
 * with the token classes when the colors arrive, and the text never changes. Highlighting is an
 * enhancement: when it is not possible the block stays plain, without a message.
 */
export function CodeBlock({
  code,
  language,
  label,
  className,
  languageClass = false,
}: {
  code: string;
  language: string | null | undefined;
  label: string;
  className?: string;
  /** Put `language-<name>` on the `code` (a lesson fence does; a quiz snippet does not show its language anywhere). */
  languageClass?: boolean;
}) {
  const name = usableLanguage(language);
  const colored = useHighlighted(code, languageForFence(name));
  const ends = useMemo(() => (colored === null ? null : splitLines(code).map((line) => line.end)), [colored, code]);

  return (
    <pre className={className} tabIndex={0} role="region" aria-label={label}>
      <code className={languageClass && name !== null ? `language-${name}` : undefined}>
        {colored === null || ends === null
          ? code
          : colored.map((tokens, index) => (
              <Fragment key={index}>
                <Tokens tokens={tokens} />
                {ends[index]}
              </Fragment>
            ))}
      </code>
    </pre>
  );
}

/**
 * A code fence of a lesson: the block, with a Copy button above it (not over it, so the button
 * never covers the code or scrolls with it). Copy puts the code from the lesson tree on the
 * clipboard, exactly. The language is named as written in the fence, for screen readers.
 */
export function LessonCodeBlock({ code, lang }: { code: string; lang: string | null | undefined }) {
  const name = usableLanguage(lang);
  const { state, copy } = useCopy();

  return (
    <div className="code-block code-prose">
      <div className="code-toolbar">
        <CopyButton state={state} hint={name !== null ? `${name} code` : "code"} onCopy={() => void copy(code)} />
      </div>
      <CodeBlock code={code} language={name} languageClass label={name !== null ? `${name} code block` : "Code block"} />
    </div>
  );
}
