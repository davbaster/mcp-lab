import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { PASS_SCORE } from "../components/ChapterCard";
import { ReviewItem } from "./ReviewItem";
import { coursePath, lessonPath, type ChapterInfo, type FailedAttempt, type Quiz } from "./quizData";

/**
 * The read-only review of a failed attempt. It lists the learner's own answers and where to
 * read again. It is never given, and cannot show, a right option or any note about one.
 */
export function FailedReview({
  courseId,
  quiz,
  choices,
  attempt,
  info,
  alreadyPassed,
  onTryAgain,
}: {
  courseId: string;
  quiz: Quiz;
  /** The index of the option picked for each question. */
  choices: readonly number[];
  attempt: FailedAttempt;
  info: ChapterInfo;
  alreadyPassed: boolean;
  onTryAgain: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <div className="quiz-review-view">
      <h2 ref={heading} tabIndex={-1}>
        {`You scored ${attempt.score}/${attempt.total}. You need ${PASS_SCORE} to pass.`}
      </h2>
      {alreadyPassed && <p>You have already passed this chapter. This score does not change that.</p>}
      <ol className="quiz-review">
        {quiz.questions.map((question, index) => {
          const lessonId = attempt.wrong.get(question.id);
          const lessonTitle = lessonId === undefined ? undefined : info.lessonTitles.get(lessonId);
          return (
            <ReviewItem
              key={index}
              number={index + 1}
              text={question.text}
              correct={lessonId === undefined}
              answerText={question.options[choices[index]].text}
            >
              {lessonId !== undefined && (
                <p>
                  <Link className="link-action" to={lessonTitle === undefined ? coursePath(courseId) : lessonPath(courseId, lessonId)}>
                    {lessonTitle === undefined ? "Review the chapter's lessons" : `Review: ${lessonTitle}`}
                  </Link>
                </p>
              )}
            </ReviewItem>
          );
        })}
      </ol>
      <button type="button" className="button button-secondary" onClick={onTryAgain}>
        Try again
      </button>
    </div>
  );
}
