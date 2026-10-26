import { COPY_TEXT, type CopyState } from "./useCopy";

/**
 * The Copy button of a code block. The live region is in the page before the first press, so the
 * change to "Copied" is announced. `hint` is for screen readers (the file or the language), so two
 * buttons on a page can be told apart; it is left out of the failure text.
 */
export function CopyButton({ state, hint, onCopy }: { state: CopyState; hint: string; onCopy: () => void }) {
  return (
    <span className="code-copy" aria-live="polite">
      <button type="button" className="button button-secondary" onClick={onCopy}>
        {COPY_TEXT[state]}
        {state !== "failed" && (
          <>
            {" "}
            <span className="visually-hidden">{hint}</span>
          </>
        )}
      </button>
    </span>
  );
}
