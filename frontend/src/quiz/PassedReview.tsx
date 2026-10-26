import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { isRecord } from "../content-components/tree";
import { InlineText } from "./InlineText";
import { ReviewItem } from "./ReviewItem";
import { coursePath, lessonPath, type ChapterInfo, type Quiz } from "./quizData";

// This is the only file that reads the key and the explanations, and only for an attempt the
// server has passed. Nothing earlier asks for them, keeps them, or shows them.

interface PassedResult {
  questionId: string;
  optionId: string;
  correctOptionId: string;
  isCorrect: boolean;
  explanation: string;
}

export interface PassedAttempt {
  score: number;
  total: number;
  nextChapterId: string | null;
  courseComplete: boolean;
  results: PassedResult[];
}

function readResult(entry: unknown): PassedResult | null {
  if (!isRecord(entry)) return null;
  const { question_id, option_id, correct_option_id, is_correct, explanation } = entry;
  if (typeof question_id !== "string" || typeof option_id !== "string" || typeof correct_option_id !== "string") return null;
  if (typeof is_correct !== "boolean" || typeof explanation !== "string") return null;
  return { questionId: question_id, optionId: option_id, correctOptionId: correct_option_id, isCorrect: is_correct, explanation };
}

/** The passed attempt, checked at run time; null if the body is not one (for example, it has no list of answers). */
// It stays in this file so the grep for the key and the explanations finds one file.
// eslint-disable-next-line react-refresh/only-export-components
export function readPassed(data: Record<string, unknown>): PassedAttempt | null {
  const { score, total, results, next_chapter_id, course_complete } = data;
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  if (typeof total !== "number" || !Number.isFinite(total) || !Array.isArray(results)) return null;
  return {
    score,
    total,
    nextChapterId: typeof next_chapter_id === "string" ? next_chapter_id : null,
    courseComplete: course_complete === true,
    results: (results as unknown[]).flatMap((entry) => {
      const result = readResult(entry);
      return result ? [result] : [];
    }),
  };
}

/**
 * The read-only review of a passed attempt: every answer with the right one and its explanation, and
 * the way on. Option text is found by id among the options of the quiz that was submitted. A result
 * that matches no question or option of it is skipped, and no id is ever shown.
 */
export function PassedReview({
  courseId,
  quiz,
  attempt,
  info,
  onRetake,
}: {
  courseId: string;
  quiz: Quiz;
  attempt: PassedAttempt;
  info: ChapterInfo;
  onRetake: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);

  const nextLesson = attempt.nextChapterId === null ? undefined : info.firstLessons.get(attempt.nextChapterId);
  const backToCourse = (
    <Link className="link-action" to={coursePath(courseId)}>
      Back to course
    </Link>
  );

  return (
    <div className="quiz-review-view">
      <h2 ref={heading} tabIndex={-1}>
        {`You passed with ${attempt.score}/${attempt.total}.`}
      </h2>
      {attempt.courseComplete && <p>You've completed the course</p>}
      <div className="quiz-actions">
        {nextLesson !== undefined ? (
          <Link className="button" to={lessonPath(courseId, nextLesson)}>
            Start the next chapter
          </Link>
        ) : (
          backToCourse
        )}
        {/* With a next chapter, Back to course would be a second way to the same place. */}
        {nextLesson !== undefined && attempt.courseComplete && backToCourse}
        <button type="button" className="button button-secondary" onClick={onRetake}>
          Retake the quiz
        </button>
      </div>
      <ol className="quiz-review" role="list">
        {quiz.questions.map((question, index) => {
          const result = attempt.results.find((candidate) => candidate.questionId === question.id);
          const picked = result && question.options.find((option) => option.id === result.optionId);
          const right = result && question.options.find((option) => option.id === result.correctOptionId);
          if (!result || !picked || !right) return null;
          return (
            <ReviewItem key={index} number={index + 1} questionId={question.id} text={question.text} correct={result.isCorrect} answerText={picked.text}>
              <p>
                Correct answer: <InlineText text={right.text} />
              </p>
              <p>
                Explanation: <InlineText text={result.explanation} />
              </p>
            </ReviewItem>
          );
        })}
      </ol>
    </div>
  );
}
