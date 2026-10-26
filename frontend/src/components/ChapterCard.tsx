import { Link } from "react-router";
import type { components } from "../api/schema";

type ChapterSummary = components["schemas"]["ChapterSummary"];
type ChapterStatus = components["schemas"]["ChapterStatus"];

/** Every quiz has 5 questions (the plan fixes it); the API does not return the total. */
export const QUESTIONS_PER_QUIZ = 5;

/** A score of 4 or more passes a quiz (the plan fixes it); the API does not return the pass mark. */
export const PASS_SCORE = 4;

const STATUS_LABEL: Record<ChapterStatus, string> = {
  locked: "Locked",
  in_progress: "In progress",
  passed: "Passed",
};

const LOCKED_NOTE = "This chapter is locked. Pass the previous chapter's quiz to unlock it.";

/** What the learner has done in a chapter. A visitor has none. */
export interface ChapterLearnerView {
  status: ChapterStatus;
  bestScore: number | null;
}

/**
 * One chapter of the dashboard: its title, a learner's status and best score, its lessons (links
 * where the backend lets the caller read them, see `backend/app/access.py`) and the quiz link.
 */
export function ChapterCard({
  courseId,
  chapter,
  learner,
}: {
  courseId: string;
  chapter: ChapterSummary;
  /** Null for a visitor. */
  learner: ChapterLearnerView | null;
}) {
  const course = encodeURIComponent(courseId);
  // A lesson opens when the chapter is not locked, or is a free preview. A visitor has no status.
  const lessonsOpen = learner ? learner.status !== "locked" || chapter.free_preview : chapter.free_preview;
  // A quiz never opens for a locked chapter, even a free-preview one.
  const quizLabel = learner?.status === "in_progress" ? "Take the quiz" : learner?.status === "passed" ? "Retake the quiz" : null;

  return (
    <li className="chapter-card">
      <h2>{chapter.title}</h2>
      {learner && (
        <p className="chapter-meta">
          <span className={`status status-${learner.status.replace("_", "-")}`}>{STATUS_LABEL[learner.status]}</span>
          <span className="muted">
            {learner.bestScore === null ? "Not attempted" : `Best score: ${learner.bestScore}/${QUESTIONS_PER_QUIZ}`}
          </span>
        </p>
      )}
      {learner?.status === "locked" && <p className="muted">{LOCKED_NOTE}</p>}
      <ol className="lesson-list">
        {chapter.lessons.map((lesson) => (
          <li key={lesson.id}>
            {lessonsOpen ? (
              <Link to={`/courses/${course}/lessons/${encodeURIComponent(lesson.id)}`}>{lesson.title}</Link>
            ) : (
              <span>{lesson.title}</span>
            )}
          </li>
        ))}
      </ol>
      {quizLabel && (
        <Link className="link-action" to={`/courses/${course}/chapters/${encodeURIComponent(chapter.id)}/quiz`}>
          {quizLabel}
        </Link>
      )}
    </li>
  );
}
