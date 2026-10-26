import { useEffect, useId, useLayoutEffect, useRef, type RefObject } from "react";
import { Link, useLocation } from "react-router";
import { returnTarget, signInPath } from "../auth/paths";
import { FeedbackForm, type FormProps } from "./FeedbackForm";

export type DialogView = "loading" | "signIn" | "thanks" | "form";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Puts focus on what the dialog asks for first (the thanks message), else on its first control. */
function focusInside(dialog: HTMLDialogElement, onlyIfLost: boolean) {
  const asked = dialog.querySelector<HTMLElement>("[data-autofocus]");
  if (asked) return asked.focus();
  if (onlyIfLost && dialog.contains(document.activeElement)) return;
  dialog.querySelector<HTMLElement>(FOCUSABLE)?.focus();
}

/**
 * The native modal `<dialog>`. The browser keeps the page behind it inert and Tab inside it, and
 * Escape closes it. This component moves focus in on open and gives it back on close.
 */
export function FeedbackDialog({
  open,
  view,
  opener,
  headerButton,
  onClosed,
  form,
}: {
  open: boolean;
  view: DialogView;
  opener: RefObject<HTMLElement | null>;
  headerButton: RefObject<HTMLButtonElement | null>;
  /** The dialog has closed, whichever way. */
  onClosed: () => void;
  form: FormProps;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const location = useLocation();
  // A close caused by a route change leaves focus to the new page's heading.
  const skipFocusReturn = useRef(false);
  const next = returnTarget(location);

  useLayoutEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [open]);

  // The component moves focus itself and does not rely on the browser's own choice.
  useEffect(() => {
    if (open && dialog.current) focusInside(dialog.current, false);
  }, [open]);

  // The content changed under the learner (Loading… became the form, a 401 became the prompt):
  // focus must not be left on something that is gone.
  useEffect(() => {
    if (open && dialog.current) focusInside(dialog.current, true);
  }, [open, view]);

  // Following a link out of the dialog, or Back, closes it. A click outside does not.
  useEffect(() => {
    const element = dialog.current;
    if (element?.open) {
      skipFocusReturn.current = true;
      element.close();
    }
  }, [location.key]);

  function close() {
    if (dialog.current?.open) dialog.current.close();
    else onClosed();
  }

  function handleClose() {
    onClosed();
    if (skipFocusReturn.current) {
      skipFocusReturn.current = false;
      return;
    }
    const from = opener.current;
    (from?.isConnected ? from : headerButton.current)?.focus();
  }

  return (
    <dialog ref={dialog} className="feedback-dialog" aria-labelledby={headingId} onClose={handleClose}>
      {open && (
        <div className="feedback-dialog-body">
          <h2 id={headingId}>Send feedback</h2>
          {view === "loading" && (
            <>
              <p role="status">Loading…</p>
              <CloseButton onClose={close} />
            </>
          )}
          {view === "signIn" && (
            <>
              <p>Sign in to send feedback</p>
              <div className="feedback-actions">
                <Link className="button" to={signInPath(next)}>
                  Sign in
                </Link>
                <CloseButton onClose={close} />
              </div>
            </>
          )}
          {view === "thanks" && (
            <>
              <p role="status" tabIndex={-1} data-autofocus>
                Thanks – we'll review it
              </p>
              <CloseButton onClose={close} />
            </>
          )}
          {view === "form" && <FeedbackForm {...form} onCancel={close} />}
        </div>
      )}
    </dialog>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="button button-secondary" onClick={onClose}>
      Close
    </button>
  );
}
