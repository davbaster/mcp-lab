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

/** Where the last send stands. It lives here, not in the dialog, so closing the dialog does not lose it. */
type Request =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "error"; message: string }
  | { kind: "unauthorized" };

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
  // Set at once on the first click, before React shows the disabled button, so a double click sends one request.
  const sending = useRef(false);

  // The draft of another page or another learner is not this learner's to see.
  const draft = stored !== null && stored.path === pathname && stored.username === username ? stored : null;
  const category = draft?.category ?? null;
  const message = draft?.message ?? "";

  const openFeedback = useCallback(
    (from: HTMLElement | null, question?: string) => {
      opener.current = from;
      // Dropped for good when it belongs to another page or another learner. While the session is
      // unknown (no username), it stays: a learner who signed in again gets it back.
      setStored((current) =>
        current !== null && (current.path !== pathname || (username !== null && current.username !== username)) ? null : current,
      );
      setQuestionId(question ?? null);
      setAboutQuestion(question !== undefined);
      // A sign-in prompt is old once the dialog is reopened; a pending or finished send is not.
      setRequest((current) => (current.kind === "unauthorized" ? IDLE : current));
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
    if (sending.current || username === null) return;
    sending.current = true;
    setRequest({ kind: "sending" });
    const body = buildFeedbackRequest({ category: chosen, message: text, pathname, questionId, aboutQuestion });
    try {
      // The 202 has no body, so this does not use `settle`: only `response.ok` says it worked.
      const { error, response } = await api.POST("/api/feedback", { body });
      if (response.ok) {
        setStored(null);
        setRequest({ kind: "sent" });
      } else {
        const failure = toApiError(error, response);
        setRequest(failure.status === 401 ? { kind: "unauthorized" } : { kind: "error", message: failure.message });
      }
    } catch (thrown) {
      setRequest({ kind: "error", message: toApiError(thrown).message });
    } finally {
      sending.current = false;
    }
  }

  const closed = useCallback(() => {
    setOpen(false);
    setQuestionId(null);
    // What the learner has seen is done with. A send still in flight keeps going, and its outcome waits.
    setRequest((current) => (current.kind === "sending" ? current : IDLE));
  }, []);

  let view: DialogView;
  if (status === "loading") view = "loading";
  else if (status === "visitor" || request.kind === "unauthorized") view = "signIn";
  else if (request.kind === "sent") view = "thanks";
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
          sending: request.kind === "sending",
          failure: request.kind === "error" ? request.message : null,
          onCategory: (next) => changeDraft({ category: next }),
          onMessage: (next) => changeDraft({ message: next }),
          onAboutQuestion: setAboutQuestion,
          onSend: (chosen, text) => void send(chosen, text),
        }}
      />
    </FeedbackContext.Provider>
  );
}
