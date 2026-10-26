import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Tokens } from "./CodeBlock";
import { CopyButton } from "./CopyButton";
import { splitLines } from "./codeLines";
import { changeSummary, chooseFile, fileLabel, FILE_REMOVED_NOTE, FIRST_STEP_NOTE, LINES_REMOVED_NOTE, markedLines, NO_CHANGES_NOTE } from "./codeChanges";
import type { CodeFile, CodeStep } from "./codeData";
import { languageForPath } from "./highlighter";
import { LogOnce } from "./LogOnce";
import { tabForKey } from "./tabKeys";
import { siteSource } from "./urls";
import { useCopy } from "./useCopy";
import { useHighlighted } from "./useHighlighted";

interface CodeViewerProps {
  name: string;
  /** All the steps of the chapter, in the API's order. */
  steps: readonly CodeStep[];
  /** Where in `steps` the viewer starts: the step named in the `step` prop. */
  start: number;
  /** The `file` prop: the file to show first. */
  file: string | null;
  zipUrl: string;
  zipFileName: string;
}

/** The step shown (a position in `steps`) and the path of the selected file in it. */
interface Position {
  index: number;
  selected: string | null;
}

/** One step's files: step buttons, tabs, the code of the selected file, Copy, and the link to the chapter's ZIP. */
export function CodeViewer({ name, steps, start, file, zipUrl, zipFileName }: CodeViewerProps) {
  const base = useId();
  // The `file` prop applies at the start only, and only to a file that is there and not deleted.
  const [propMissed] = useState(() => file !== null && !steps[start].files.some((candidate) => candidate.path === file && candidate.status !== "deleted"));
  const [where, setWhere] = useState<Position>(() => ({ index: start, selected: chooseFile(steps[start].files, propMissed ? null : file) }));
  const clipboard = useCopy();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const stepButtons = useRef<{ previous: HTMLButtonElement | null; next: HTMLButtonElement | null }>({ previous: null, next: null });
  const pressed = useRef<"previous" | "next" | null>(null);

  const lastIndex = steps.length - 1;
  const index = Math.min(where.index, lastIndex);
  const shown = steps[index];
  const files = shown.files;
  const firstStep = index === 0;
  const found = files.findIndex((candidate) => candidate.path === where.selected);
  const active = Math.max(found, 0);
  const current: CodeFile | undefined = files[active];
  const lastFile = files.length - 1;
  const zip = siteSource(zipUrl);

  // A step button that the press just disabled would drop the keyboard focus, so it goes to the other one.
  useEffect(() => {
    const button = pressed.current;
    pressed.current = null;
    if (button === null) return;
    if (stepButtons.current[button]?.disabled) stepButtons.current[button === "next" ? "previous" : "next"]?.focus();
  }, [index]);

  /** A new file (or a new step) starts with "Copy", and the old timer or clipboard answer must not change it. */
  const resetCopy = clipboard.reset;

  function select(position: number, focus: boolean) {
    if (position !== active) resetCopy();
    setWhere((previous) => ({ ...previous, selected: files[position].path }));
    if (focus) buttons.current[position]?.focus();
  }

  function move(delta: 1 | -1) {
    pressed.current = delta === 1 ? "next" : "previous";
    resetCopy();
    setWhere((previous) => {
      const next = Math.min(Math.max(Math.min(previous.index, lastIndex) + delta, 0), lastIndex);
      return { index: next, selected: chooseFile(steps[next].files, previous.selected) };
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = tabForKey(event, active, lastFile);
    if (next === null) return;
    event.preventDefault();
    select(next, true);
  }

  const changes = firstStep ? FIRST_STEP_NOTE : (changeSummary(files) ?? NO_CHANGES_NOTE);
  const finalStep = steps[lastIndex].step;
  const zipHint =
    index < lastIndex
      ? `This ZIP has the final code of the whole chapter (step ${finalStep}), not only step ${shown.step}.`
      : "This ZIP has the final code of the whole chapter.";

  return (
    <>
      {propMissed && <LogOnce level="warn" message={`Lesson component "${name}": the file for step ${steps[start].step} is not one of its files, so the first changed file is shown`} />}
      <div className="code-step-bar">
        {/* The live region is in the page before the first press, so a step change is announced. */}
        <div className="code-step-status" role="status">
          <span className="code-step-count">{`Step ${shown.step} of ${steps.length}`}</span>
          <span className="code-step-changes">{changes}</span>
        </div>
        <div className="code-step-buttons">
          <button
            type="button"
            className="button button-secondary"
            ref={(element) => {
              stepButtons.current.previous = element;
            }}
            disabled={index === 0}
            onClick={() => move(-1)}
          >
            Previous step
          </button>
          <button
            type="button"
            className="button button-secondary"
            ref={(element) => {
              stepButtons.current.next = element;
            }}
            disabled={index === lastIndex}
            onClick={() => move(1)}
          >
            Next step
          </button>
        </div>
      </div>
      {current === undefined ? (
        <p className="code-empty">This step has no files</p>
      ) : (
        <>
          <div className="tablist" role="tablist" aria-label={`Files in step ${shown.step}`} onKeyDown={onKeyDown}>
            {files.map((candidate, position) => {
              const label = firstStep ? null : fileLabel(candidate.status);
              return (
                <button
                  key={position}
                  ref={(element) => {
                    buttons.current[position] = element;
                  }}
                  type="button"
                  role="tab"
                  className="tab"
                  id={`${base}-tab-${position}`}
                  aria-selected={position === active}
                  aria-controls={`${base}-panel`}
                  tabIndex={position === active ? 0 : -1}
                  onClick={() => select(position, false)}
                >
                  {candidate.path}
                  {label !== null && (
                    <>
                      {" "}
                      <span className={`file-label file-label-${candidate.status}`}>{label}</span>
                    </>
                  )}
                </button>
              );
            })}
          </div>
          <div className="tabpanel code-panel" role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${active}`}>
            {current.status === "deleted" ? (
              <p className="code-block code-empty">{FILE_REMOVED_NOTE}</p>
            ) : (
              <>
                {!firstStep && current.status === "modified" && current.changedLines.length === 0 && <p className="code-note">{LINES_REMOVED_NOTE}</p>}
                <div className="code-block">
                  <div className="code-toolbar">
                    {/* The text comes from the API data, not from the page. The file's name is for screen readers. */}
                    <CopyButton state={clipboard.state} hint={current.path} onCopy={() => void clipboard.copy(current.content)} />
                  </div>
                  {current.content === "" ? (
                    <p className="code-empty">This file is empty</p>
                  ) : (
                    <CodeArea key={current.path} file={current} firstStep={firstStep} />
                  )}
                </div>
              </>
            )}
          </div>
        </>
      )}
      {zip !== null && (
        <div className="code-zip">
          <a className="link-action" href={zip} download={zipFileName}>
            Download chapter code (ZIP)
          </a>
          <p className="code-zip-hint">{zipHint}</p>
        </div>
      )}
    </>
  );
}

/**
 * The code of one file. Every line is one element with its number outside the text, and the text
 * of all the line elements together is the file's content, line breaks included. The lines are
 * plain text first, and the same elements get their colors when the highlighter is ready. A line
 * that changed since the previous step (step mode) is marked from the first render on, with the
 * "changed" text for screen readers outside the element that holds the code.
 */
function CodeArea({ file, firstStep }: { file: CodeFile; firstStep: boolean }) {
  const { path, content } = file;
  const lines = useMemo(() => splitLines(content), [content]);
  const marked = useMemo(() => markedLines(file, lines.length, firstStep), [file, lines.length, firstStep]);
  const language = languageForPath(path);
  const colored = useHighlighted(content, language);
  const digits = Math.min(String(lines.length).length, 6);

  return (
    <div className={`code-area code-digits-${digits}`} role="region" aria-label={path} tabIndex={0}>
      <div className="code-lines">
      {lines.map((line, index) => (
        <div className={marked.has(index + 1) ? "code-line code-line-changed" : "code-line"} key={index}>
          {marked.has(index + 1) && <span className="code-line-flag visually-hidden">changed</span>}
          <span className="code-line-number" aria-hidden="true">
            {index + 1}
          </span>
          <code className="code-line-text">
            {colored === null ? (
              line.text + line.end
            ) : (
              <>
                <Tokens tokens={colored[index]} />
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
