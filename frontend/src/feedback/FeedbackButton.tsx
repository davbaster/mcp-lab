import { useFeedback } from "./useFeedback";

/** The header button that opens the feedback dialog. It is on every page, for visitors too. */
export function FeedbackButton() {
  const { openFeedback, headerButton } = useFeedback();
  return (
    <button
      ref={headerButton}
      type="button"
      className="button button-secondary"
      onClick={(event) => openFeedback(event.currentTarget)}
    >
      Send feedback
    </button>
  );
}
