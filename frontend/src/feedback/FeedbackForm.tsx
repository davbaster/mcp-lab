import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { codePointLength } from "./safeText";
import { cleanMessage, MAX_MESSAGE_LENGTH, MIN_MESSAGE_LENGTH, type FeedbackCategory } from "./context";

const CATEGORIES: { value: FeedbackCategory; label: string; hint?: string }[] = [
  { value: "bug", label: "Bug" },
  { value: "content_error", label: "Content error", hint: "Something is wrong in a lesson, code sample, or quiz" },
  { value: "confusing_explanation", label: "Confusing explanation" },
  { value: "suggestion", label: "Suggestion" },
];

const CATEGORY_MESSAGE = "Choose a category.";
const TOO_SHORT_MESSAGE = `Write at least ${MIN_MESSAGE_LENGTH} characters.`;
const TOO_LONG_MESSAGE = `Use ${MAX_MESSAGE_LENGTH} characters or fewer.`;

interface Errors {
  category?: string;
  message?: string;
}

/** What the server will count: the cleaned, trimmed text in code points. */
function messageLength(text: string): number {
  return codePointLength(cleanMessage(text));
}

function messageProblem(text: string): string | undefined {
  const length = messageLength(text);
  if (length < MIN_MESSAGE_LENGTH) return TOO_SHORT_MESSAGE;
  if (length > MAX_MESSAGE_LENGTH) return TOO_LONG_MESSAGE;
  return undefined;
}

export interface FormProps {
  category: FeedbackCategory | null;
  message: string;
  /** null when the dialog was not opened from a quiz question: there is no box. */
  aboutQuestion: boolean | null;
  sending: boolean;
  /** The message of a failed send, shown above the form. */
  failure: string | null;
  onCategory: (category: FeedbackCategory) => void;
  onMessage: (message: string) => void;
  onAboutQuestion: (about: boolean) => void;
  /** Called only with a valid category and message. */
  onSend: (category: FeedbackCategory, message: string) => void;
}

export function FeedbackForm({
  category,
  message,
  aboutQuestion,
  sending,
  failure,
  onCategory,
  onMessage,
  onAboutQuestion,
  onSend,
  onCancel,
}: FormProps & { onCancel: () => void }) {
  const id = useId();
  const [errors, setErrors] = useState<Errors>({});
  const pendingFocus = useRef<"category" | "message" | null>(null);
  const firstRadio = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const sendButton = useRef<HTMLButtonElement>(null);
  const wasSending = useRef(false);

  const ids = {
    group: `${id}-category`,
    categoryError: `${id}-category-error`,
    message: `${id}-message`,
    count: `${id}-count`,
    messageError: `${id}-message-error`,
    hint: `${id}-hint`,
  };

  // Focus goes to the first invalid field once its error is linked to it.
  useEffect(() => {
    const field = pendingFocus.current;
    pendingFocus.current = null;
    if (field === "category") firstRadio.current?.focus();
    if (field === "message") textarea.current?.focus();
  }, [errors]);

  // The disabled button cannot keep focus, so give it back when a failed send enables it again.
  useEffect(() => {
    if (sending) {
      wasSending.current = true;
    } else if (wasSending.current) {
      wasSending.current = false;
      sendButton.current?.focus();
    }
  }, [sending]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (sending) return;
    const problem = messageProblem(message);
    const found: Errors = {
      ...(category === null && { category: CATEGORY_MESSAGE }),
      ...(problem && { message: problem }),
    };
    setErrors(found);
    if (found.category || found.message) {
      pendingFocus.current = found.category ? "category" : "message";
      return;
    }
    if (category !== null) onSend(category, message);
  }

  function handleMessage(text: string) {
    onMessage(text);
    // An error that is showing follows the text until it is fixed.
    setErrors((current) => (current.message === undefined ? current : { ...current, message: messageProblem(text) }));
  }

  const categoryDescribed = errors.category ? ids.categoryError : undefined;
  const messageDescribed = [ids.count, errors.message ? ids.messageError : null].filter(Boolean).join(" ");

  return (
    <>
      {failure !== null && (
        <div className="error-box" role="alert">
          <p>{failure}</p>
        </div>
      )}
      <form className="feedback-form" noValidate onSubmit={handleSubmit}>
        <fieldset
          className="feedback-category"
          aria-invalid={errors.category ? "true" : undefined}
          aria-describedby={categoryDescribed}
        >
          <legend>Category</legend>
          {CATEGORIES.map((option, index) => (
            <div key={option.value}>
              <label className="feedback-choice">
                <input
                  ref={index === 0 ? firstRadio : undefined}
                  type="radio"
                  name={ids.group}
                  value={option.value}
                  checked={category === option.value}
                  aria-describedby={option.hint ? ids.hint : undefined}
                  onChange={() => {
                    onCategory(option.value);
                    setErrors((current) => ({ ...current, category: undefined }));
                  }}
                />
                <span>{option.label}</span>
              </label>
              {option.hint && (
                <p className="hint feedback-hint" id={ids.hint}>
                  {option.hint}
                </p>
              )}
            </div>
          ))}
          {errors.category && (
            <p className="field-error" id={ids.categoryError}>
              {errors.category}
            </p>
          )}
        </fieldset>
        <div className="field">
          <label htmlFor={ids.message}>Message</label>
          <textarea
            ref={textarea}
            id={ids.message}
            rows={6}
            value={message}
            aria-invalid={errors.message ? "true" : undefined}
            aria-describedby={messageDescribed}
            onChange={(event) => handleMessage(event.target.value)}
          />
          <p className="hint" id={ids.count}>
            {`${messageLength(message)} / ${MAX_MESSAGE_LENGTH}`}
          </p>
          {errors.message && (
            <p className="field-error" id={ids.messageError}>
              {errors.message}
            </p>
          )}
        </div>
        {aboutQuestion !== null && (
          <label className="feedback-choice">
            <input type="checkbox" checked={aboutQuestion} onChange={(event) => onAboutQuestion(event.target.checked)} />
            <span>This is about the current quiz question</span>
          </label>
        )}
        <p className="hint feedback-privacy">
          The page you are on, your browser, and recent errors are sent with your feedback.
        </p>
        <div className="feedback-actions">
          <button ref={sendButton} type="submit" className="button" disabled={sending}>
            {sending ? "Sending…" : "Send"}
          </button>
          <button type="button" className="button button-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </>
  );
}
