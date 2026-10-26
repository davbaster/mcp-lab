import type { ReactNode } from "react";
import { QuestionFeedbackButton } from "../feedback/QuestionFeedbackButton";
import { InlineText } from "./InlineText";

/** One question of a read-only review: its number and text, the verdict, the learner's own answer, and extras. */
export function ReviewItem({
  number,
  questionId,
  text,
  correct,
  answerText,
  children,
}: {
  number: number;
  questionId: string;
  text: string;
  correct: boolean;
  /** The text of the option the learner picked. */
  answerText: string;
  children?: ReactNode;
}) {
  return (
    <li className="quiz-review-item">
      <p className="quiz-review-question">
        <span className="quiz-question-number">Question {number}</span> <InlineText text={text} />
      </p>
      <p className="quiz-verdict-line">
        {/* The word carries the meaning; the color only backs it up. */}
        <span className={`status ${correct ? "quiz-correct" : "quiz-incorrect"}`}>{correct ? "Correct" : "Incorrect"}</span>
      </p>
      <p>
        Your answer: <InlineText text={answerText} />
      </p>
      {children}
      <QuestionFeedbackButton questionId={questionId} number={number} />
    </li>
  );
}
