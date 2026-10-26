import { useFeedback } from "./useFeedback";

/** The button after a quiz question that opens the dialog about that question. */
export function QuestionFeedbackButton({ questionId, number }: { questionId: string; number: number }) {
  const { openFeedback } = useFeedback();
  return (
    <button
      type="button"
      className="button button-secondary feedback-question-button"
      aria-label={`Send feedback about this question (question ${number})`}
      onClick={(event) => openFeedback(event.currentTarget, questionId)}
    >
      Send feedback about this question
    </button>
  );
}
