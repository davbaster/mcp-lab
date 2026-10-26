import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { splitLines } from "./codeLines";
import type { CodeFile } from "./codeData";
import { highlight, languageForPath, MAX_HIGHLIGHT_CHARS, type HighlightedLines } from "./highlighter";
import { LogOnce } from "./LogOnce";
import { tabForKey } from "./tabKeys";
import { siteSource } from "./urls";

/** How long "Copied" stays. */
const COPIED_MS = 2000;

type CopyState = "idle" | "copied" | "failed";

const COPY_TEXT: Record<CopyState, string> = {
  idle: "Copy",
  copied: "Copied",
  failed: "Copy failed – select the code to copy it",
};

interface CodeViewerProps {
  name: string;
  step: number;
  /** The `file` prop: the file to show first. */
  file: string | null;
  /** The files to show, in the API's order. Never empty. */
  files: readonly CodeFile[];
  zipUrl: string;
  zipFileName: string;
}

/** One step's files: tabs, the code of the selected file, Copy, and the link to the chapter's ZIP. */
export function CodeViewer({ name, step, file, files, zipUrl, zipFileName }: CodeViewerProps) {
  const base = useId();
  const startIndex = file === null ? -1 : files.findIndex((candidate) => candidate.path === file);
  const [selected, setSelected] = useState(Math.max(startIndex, 0));
  const [copy, setCopy] = useState<CopyState>("idle");
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const timer = useRef<number | null>(null);
  // Which press of Copy (or which file) an answer from the clipboard belongs to.
  const attempt = useRef(0);

  const last = files.length - 1;
  const active = Math.min(selected, last);
  const current = files[active];
  const zip = siteSource(zipUrl);

  function stopTimer() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }

  useEffect(
    () => () => {
      attempt.current += 1;
      stopTimer();
    },
    [],
  );

  function select(index: number, focus: boolean) {
    if (index !== active) {
      // A new file starts with "Copy", and the old file's timer or clipboard answer must not change it.
      attempt.current += 1;
      stopTimer();
      setCopy("idle");
    }
    setSelected(index);
    if (focus) buttons.current[index]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = tabForKey(event, active, last);
    if (next === null) return;
    event.preventDefault();
    select(next, true);
  }

  async function copyFile() {
    stopTimer();
    const mine = ++attempt.current;
    let result: CopyState = "copied";
    try {
      // The text comes from the API data, not from the page. `navigator.clipboard` is missing on an insecure page.
      await navigator.clipboard.writeText(current.content);
    } catch {
      result = "failed";
    }
    if (mine !== attempt.current) return;
    setCopy(result);
    if (result === "copied") {
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setCopy("idle");
      }, COPIED_MS);
    }
  }

  return (
    <>
      {startIndex < 0 && file !== null && (
        <LogOnce level="warn" message={`Lesson component "${name}": the file for step ${step} is not one of its files, so the first file is shown`} />
      )}
      <div className="tablist" role="tablist" aria-label={`Files in step ${step}`} onKeyDown={onKeyDown}>
        {files.map((candidate, index) => (
          <button
            key={index}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="tab"
            className="tab"
            id={`${base}-tab-${index}`}
            aria-selected={index === active}
            aria-controls={`${base}-panel`}
            tabIndex={index === active ? 0 : -1}
            onClick={() => select(index, false)}
          >
            {candidate.path}
          </button>
        ))}
      </div>
      <div className="tabpanel code-panel" role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${active}`}>
        <div className="code-block">
          <div className="code-toolbar">
            {/* The live region is in the page before the first press, so a change is announced. */}
            <span className="code-copy" aria-live="polite">
              <button type="button" className="button button-secondary" onClick={() => void copyFile()}>
                {COPY_TEXT[copy]}
                {/* The file's name is for screen readers, so two viewers' buttons can be told apart. */}
                {copy !== "failed" && (
                  <>
                    {" "}
                    <span className="visually-hidden">{current.path}</span>
                  </>
                )}
              </button>
            </span>
          </div>
          {current.content === "" ? (
            <p className="code-empty">This file is empty</p>
          ) : (
            <CodeArea key={current.path} path={current.path} content={current.content} />
          )}
        </div>
      </div>
      {zip !== null && (
        <div className="code-zip">
          <a className="link-action" href={zip} download={zipFileName}>
            Download chapter code (ZIP)
          </a>
          <p className="code-zip-hint">This ZIP has the final code of the whole chapter, not only step {step}.</p>
        </div>
      )}
    </>
  );
}

/**
 * The code of one file. Every line is one element with its number outside the text, and the text
 * of all the line elements together is the file's content, line breaks included. The lines are
 * plain text first, and the same elements get their colors when the highlighter is ready.
 */
function CodeArea({ path, content }: { path: string; content: string }) {
  const lines = useMemo(() => splitLines(content), [content]);
  const language = languageForPath(path);
  const [highlighted, setHighlighted] = useState<{ content: string; lines: HighlightedLines } | null>(null);

  useEffect(() => {
    if (language === null || content.length > MAX_HIGHLIGHT_CHARS) return;
    let current = true;
    void highlight(content, language).then((result) => {
      if (current && result !== null) setHighlighted({ content, lines: result });
    });
    return () => {
      current = false;
    };
  }, [content, language]);

  const colored = highlighted !== null && highlighted.content === content && highlighted.lines.length === lines.length ? highlighted.lines : null;
  const digits = Math.min(String(lines.length).length, 6);

  return (
    <div className={`code-area code-digits-${digits}`} role="region" aria-label={path} tabIndex={0}>
      <div className="code-lines">
      {lines.map((line, index) => (
        <div className="code-line" key={index}>
          <span className="code-line-number" aria-hidden="true">
            {index + 1}
          </span>
          <code className="code-line-text">
            {colored === null ? (
              line.text + line.end
            ) : (
              <>
                {colored[index].map((token, position) =>
                  token.className === null ? (
                    token.text
                  ) : (
                    <span key={position} className={token.className}>
                      {token.text}
                    </span>
                  ),
                )}
                {line.end}
              </>
            )}
          </code>
        </div>
      ))}
      </div>
    </div>
  );
}
