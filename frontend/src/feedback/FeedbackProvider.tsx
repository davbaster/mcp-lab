import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { toApiError } from "../api/apiError";
import { api } from "../api/client";
import { useAuth } from "../auth/useAuth";
import { buildFeedbackRequest, type FeedbackCategory } from "./context";
import { FeedbackContext, type FeedbackValue } from "./feedbackContext";
import { FeedbackDialog, type DialogView } from "./FeedbackDialog";
import "./feedback.css";

/** What the learner has typed. It belongs to one page and one learner, and lives in memory only. */
interface Draft {
  path: string;
  username: string;
  category: FeedbackCategory | null;
  message: string;
}

/**
 * Where the last send stands, and whose it is: the page and the learner it was sent from. It lives
 * here, not in the dialog, so closing the dialog does not lose it. An answer that arrives after the
 * learner moved to another page, or another learner signed in, is not theirs to see.
 */
type Outcome =
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "error"; message: string }
  | { kind: "unauthorized" };
type Request = { kind: "idle" } | ({ id: number; path: string; username: string } & Outcome);

const IDLE: Request = { kind: "idle" };

/**
 * Owns the feedback dialog: whether it is open, what opened it, the draft, and the request. A quiz
 * question opens it through `useFeedback()`. Nothing is written to storage: a reload loses the draft.
 */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const { status, username } = useAuth();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [stored, setStored] = useState<Draft | null>(null);
  const [questionId, setQuestionId] = useState<string | null>(null);
  const [aboutQuestion, setAboutQuestion] = useState(false);
  const [request, setRequest] = useState<Request>(IDLE);
  const opener = useRef<HTMLElement | null>(null);
  const headerButton = useRef<HTMLButtonElement | null>(null);
  // Set at once on the first click, before React shows the disabled button, so a double click sends
  // one request. One per page and learner: a send still in flight elsewhere does not block this one.
  const sending = useRef<string | null>(null);
  const requestCount = useRef(0);
  // The page and learner that the open dialog was opened for.
  const openedFor = useRef<{ path: string; username: string | null } | null>(null);

  // The draft of another page or another learner is not this learner's to see.
  const draft = stored !== null && stored.path === pathname && stored.username === username ? stored : null;
  // The send that is shown: only one from this page by this learner.
  const mine = request.kind !== "idle" && request.path === pathname && request.username === username ? request : IDLE;
  const category = draft?.category ?? null;
  const message = draft?.message ?? "";

  const openFeedback = useCallback(
    (from: HTMLElement | null, question?: string) => {
      opener.current = from;
      openedFor.current = { path: pathname, username };
      // Dropped for good when it belongs to another page or another learner. While the session is
      // unknown (no username), it stays: a learner who signed in again gets it back.
      setStored((current) =>
        current !== null && (current.path !== pathname || (username !== null && current.username !== username)) ? null : current,
      );
      setQuestionId(question ?? null);
      setAboutQuestion(question !== undefined);
      // A sign-in prompt is old once the dialog is reopened; a pending or finished send is not.
      setRequest((current) => (current.kind === "unauthorized" && current.path === pathname ? IDLE : current));
      setOpen(true);
    },
    [pathname, username],
  );

  const value = useMemo<FeedbackValue>(() => ({ openFeedback, headerButton }), [openFeedback]);

  function changeDraft(patch: Partial<Pick<Draft, "category" | "message">>) {
    if (username === null) return;
    setStored({ path: pathname, username, category, message, ...patch });
  }

  async function send(chosen: FeedbackCategory, text: string) {
    if (username === null) return;
    const owner = { path: pathname, username };
    const key = JSON.stringify([owner.username, owner.path]);
    if (sending.current === key) return;
    sending.current = key;
    const id = ++requestCount.current;
    setRequest({ id, ...owner, kind: "sending" });
    const body = buildFeedbackRequest({ category: chosen, message: text, pathname, questionId, aboutQuestion });
    // The answer replaces this send's own entry, and nothing newer.
    const finish = (outcome: Outcome) => setRequest((current) => (current.kind !== "idle" && current.id === id ? { id, ...owner, ...outcome } : current));
    try {
      // The 202 has no body, so this does not use `settle`: only `response.ok` says it worked.
      const { error, response } = await api.POST("/api/feedback", { body });
      if (response.ok) {
        // What was sent is no longer a draft, wherever the learner is now. Another page's draft stays.
        setStored((current) => (current !== null && current.path === owner.path && current.username === owner.username ? null : current));
        finish({ kind: "sent" });
      } else {
        const failure = toApiError(error, response);
        finish(failure.status === 401 ? { kind: "unauthorized" } : { kind: "error", message: failure.message });
      }
    } catch (thrown) {
      finish({ kind: "error", message: toApiError(thrown).message });
    } finally {
      if (sending.current === key) sending.current = null;
    }
  }

  const closed = useCallback(() => {
    setOpen(false);
    setQuestionId(null);
    // What the learner has seen is done with. A send still in flight keeps going, and its outcome waits.
    // An answer for another page or learner was not shown in this dialog, so it waits too. The
    // dialog can close after the route changed (that is why it closes), so it remembers its page.
    const shown = openedFor.current;
    setRequest((current) =>
      current.kind === "idle" || current.kind === "sending" || current.path !== shown?.path || current.username !== shown.username
        ? current
        : IDLE,
    );
  }, []);

  let view: DialogView;
  if (status === "loading") view = "loading";
  else if (status === "visitor" || mine.kind === "unauthorized") view = "signIn";
  else if (mine.kind === "sent") view = "thanks";
  else view = "form";

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <FeedbackDialog
        open={open}
        view={view}
        opener={opener}
        headerButton={headerButton}
        onClosed={closed}
        form={{
          category,
          message,
          // The box only exists for a dialog opened from a quiz question.
          aboutQuestion: questionId === null ? null : aboutQuestion,
          sending: mine.kind === "sending",
          failure: mine.kind === "error" ? mine.message : null,
          onCategory: (next) => changeDraft({ category: next }),
          onMessage: (next) => changeDraft({ message: next }),
          onAboutQuestion: setAboutQuestion,
          onSend: (chosen, text) => void send(chosen, text),
        }}
      />
    </FeedbackContext.Provider>
  );
}
