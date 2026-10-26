import { useEffect, useId, useRef, type FormEvent, type Ref } from "react";
import { PASS_SCORE, QUESTIONS_PER_QUIZ } from "../components/ChapterCard";
import { CodeBlock } from "../content-components/CodeBlock";
import { QuestionFeedbackButton } from "../feedback/QuestionFeedbackButton";
import { InlineText } from "./InlineText";
import type { Quiz } from "./quizData";

/** The quiz as a form: one group of radios per question, in the order the API sent them. */
export function QuizForm({
  quiz,
  choices,
  submitting,
  error,
  firstQuestion,
  onChoose,
  onSubmit,
}: {
  quiz: Quiz;
  /** The index of the picked option for each question, or null. */
  choices: readonly (number | null)[];
  submitting: boolean;
  /** The message of a failed submit, shown above the button. */
  error: string | null;
  firstQuestion: Ref<HTMLFieldSetElement>;
  onChoose: (question: number, option: number) => void;
  onSubmit: () => void;
}) {
  const formId = useId();
  const counterId = `${formId}-count`;
  const total = quiz.questions.length;
  const answered = choices.filter((choice) => choice !== null).length;
  const button = useRef<HTMLButtonElement>(null);
  const wasSubmitting = useRef(false);

  // The disabled button cannot keep focus, so give it back when a failed submit enables it again.
  useEffect(() => {
    if (submitting) {
      wasSubmitting.current = true;
    } else if (wasSubmitting.current) {
      wasSubmitting.current = false;
      button.current?.focus();
    }
  }, [submitting]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    // Enter inside a group can submit; the caller checks that every question has an answer.
    onSubmit();
  }

  return (
    <form className="quiz-form" onSubmit={handleSubmit} noValidate>
      <p className="quiz-intro">
        {`Answer all ${QUESTIONS_PER_QUIZ} questions. You need ${PASS_SCORE} to pass, and you can retake the quiz as often as you like.`}
      </p>
      <ol className="quiz-questions" role="list">
        {quiz.questions.map((question, qi) => (
          <li key={qi}>
            <fieldset className="quiz-question" disabled={submitting} tabIndex={-1} ref={qi === 0 ? firstQuestion : undefined}>
              <legend>
                <span className="quiz-question-number">Question {qi + 1}</span> <InlineText text={question.text} />
              </legend>
              {question.code !== null && (
                <CodeBlock code={question.code} language={question.language} label={`Code for question ${qi + 1}`} className="quiz-snippet" />
              )}
              {question.options.map((option, oi) => (
                <label key={oi} className="quiz-option">
                  <input
                    type="radio"
                    name={`${formId}-${qi}`}
                    checked={choices[qi] === oi}
                    onChange={() => onChoose(qi, oi)}
                  />
                  <span className="quiz-option-text">
                    <InlineText text={option.text} />
                  </span>
                </label>
              ))}
            </fieldset>
            <QuestionFeedbackButton questionId={question.id} number={qi + 1} />
          </li>
        ))}
      </ol>
      {error !== null && (
        <div className="error-box" role="alert">
          <p>{error}</p>
        </div>
      )}
      <div className="quiz-submit">
        <button ref={button} type="submit" className="button" disabled={answered < total || submitting} aria-describedby={counterId}>
          {submitting ? "Submitting…" : "Submit answers"}
        </button>
        <span id={counterId} className="muted">
          {`${answered} of ${total} answered`}
        </span>
      </div>
    </form>
  );
}
