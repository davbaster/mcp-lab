import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { UNEXPECTED_RESPONSE_MESSAGE, type ApiError } from "../api/apiError";
import { api } from "../api/client";
import type { components } from "../api/schema";
import { settle } from "../api/settle";
import { registerPath, signInPath } from "../auth/paths";
import { useAuth } from "../auth/useAuth";
import { ChapterCard, type ChapterLearnerView } from "../components/ChapterCard";
import { PageHeading } from "../components/PageHeading";
import { useDocumentTitle } from "../lib/useDocumentTitle";

type CourseSummary = components["schemas"]["CourseSummary"];
type ChapterSummary = components["schemas"]["ChapterSummary"];
type ChapterProgress = components["schemas"]["ChapterProgressSummary"];
type CourseProgress = components["schemas"]["CourseProgressResponse"];

/** `key` says which course and which kind of caller the answer is for, so a stale one is ignored. */
type State =
  | { kind: "loading" }
  | { kind: "error"; key: string; message: string }
  | { kind: "notFound"; key: string }
  | { kind: "loaded"; key: string; course: CourseSummary; chapters: ChapterSummary[]; progress: CourseProgress | null };

const isNotAuthenticated = (failure: ApiError) => failure.status === 401 && failure.code === "not_authenticated";
const isCourseNotFound = (failure: ApiError) => failure.status === 404 && failure.code === "course_not_found";

function firstLesson(chapter: ChapterSummary | undefined): string | null {
  return chapter?.lessons[0]?.id ?? null;
}

/** The lesson Resume opens: the saved one of the first in-progress chapter, else its first lesson. */
function resumeTarget(chapters: ChapterSummary[], progress: Map<string, ChapterProgress>): string | null {
  const chapter = chapters.find((c) => (progress.get(c.id)?.status ?? c.status) === "in_progress");
  if (!chapter) return null;
  const last = progress.get(chapter.id)?.last_lesson_id;
  if (last && chapter.lessons.some((lesson) => lesson.id === last)) return last;
  return firstLesson(chapter);
}

function lessonPath(courseId: string, lessonId: string): string {
  return `/courses/${encodeURIComponent(courseId)}/lessons/${encodeURIComponent(lessonId)}`;
}

export function DashboardPage() {
  const courseId = useParams().courseId ?? "";
  const auth = useAuth();
  const mode = auth.status;
  const key = `${mode}:${courseId}`;
  const [state, setState] = useState<State>({ kind: "loading" });
  const region = useRef<HTMLElement>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    const learner = mode === "learner";
    const params = { params: { path: { course_id: courseId } } };
    const [courses, chapters, progress] = await Promise.all([
      settle(api.GET("/api/courses")),
      settle(api.GET("/api/courses/{course_id}/chapters", params)),
      learner ? settle(api.GET("/api/courses/{course_id}/progress", params)) : Promise.resolve(null),
    ]);

    // A 401 from the progress call is not a failure: the learner's session ended, so the page shows
    // the visitor view. A 401 from the public calls is one (the server never needs a session for them);
    // if AuthProvider flips to visitor, the key changes and this answer is never shown.
    let next: State;
    const failures = [courses, chapters, progress].flatMap((r, i) =>
      r && "failure" in r && !(i === 2 && isNotAuthenticated(r.failure)) ? [r.failure] : [],
    );
    const found = "data" in courses ? courses.data.courses.find((c) => c.id === courseId) : undefined;
    if (failures.some(isCourseNotFound) || ("data" in courses && !found)) {
      next = { kind: "notFound", key };
    } else if (failures.length > 0 || !found || !("data" in chapters)) {
      next = { kind: "error", key, message: failures[0]?.message ?? UNEXPECTED_RESPONSE_MESSAGE };
    } else {
      next = {
        kind: "loaded",
        key,
        course: found,
        chapters: chapters.data.chapters,
        progress: progress && "data" in progress ? progress.data : null,
      };
    }
    // Only the newest request may update the page.
    if (id === requestId.current) setState(next);
  }, [courseId, mode, key]);

  useEffect(() => {
    if (mode === "loading") return;
    void load();
    return () => {
      requestId.current += 1;
    };
  }, [load, mode]);

  function tryAgain() {
    setState({ kind: "loading" });
    // The button is about to be removed, so focus moves to the region that stays.
    region.current?.focus();
    void load();
  }

  // An answer for another course, or for a caller who has since changed, is not shown.
  const current = state.kind !== "loading" && state.key === key && mode !== "loading" ? state : null;
  const title = current?.kind === "loaded" ? current.course.title : current?.kind === "notFound" ? "Course not found" : "Course";
  useDocumentTitle(title);

  return (
    <>
      <PageHeading>{title}</PageHeading>
      <section aria-label="Course dashboard" ref={region} tabIndex={-1}>
        {!current && <p role="status">Loading…</p>}
        {current?.kind === "error" && (
          <div role="alert">
            <p>{current.message}</p>
            <button type="button" className="button" onClick={tryAgain}>
              Try again
            </button>
          </div>
        )}
        {current?.kind === "notFound" && (
          <Link className="link-action" to="/">
            Back to all courses
          </Link>
        )}
        {current?.kind === "loaded" && (
          <Loaded
            courseId={courseId}
            course={current.course}
            chapters={current.chapters}
            progress={mode === "learner" ? current.progress : null}
          />
        )}
      </section>
    </>
  );
}

function Loaded({
  courseId,
  course,
  chapters,
  progress,
}: {
  courseId: string;
  course: CourseSummary;
  chapters: ChapterSummary[];
  /** Null for a visitor, and for a learner whose progress could not be read. */
  progress: CourseProgress | null;
}) {
  const progressById = new Map((progress?.chapters ?? []).map((entry) => [entry.id, entry]));
  const complete = progress?.course_complete === true;

  let action: { label: string; to: string } | null = null;
  if (progress) {
    const target = complete ? null : resumeTarget(chapters, progressById);
    if (target) {
      const started =
        progress.chapters.some((c) => c.last_lesson_id !== null) ||
        chapters.some((c) => (progressById.get(c.id)?.status ?? c.status) === "passed");
      action = { label: started ? "Resume" : "Start course", to: lessonPath(courseId, target) };
    }
  } else {
    const preview = firstLesson(chapters.find((c) => c.free_preview && c.lessons.length > 0));
    if (preview) action = { label: "Start reading", to: lessonPath(courseId, preview) };
  }

  return (
    <>
      <p className="course-description">{course.description}</p>
      {action && (
        <p>
          <Link className="button" to={action.to}>
            {action.label}
          </Link>
        </p>
      )}
      {complete && (
        <div className="course-complete">
          <h2>Course complete</h2>
          <p>You have passed every chapter. You can review any lesson below.</p>
        </div>
      )}
      {!progress && <SignInPrompt courseId={courseId} />}
      <ol className="chapter-list">
        {chapters.map((chapter) => {
          const entry = progressById.get(chapter.id);
          // No progress entry and no status from the chapters call: nothing says it is open, so locked.
          const learner: ChapterLearnerView | null = progress
            ? { status: entry?.status ?? chapter.status ?? "locked", bestScore: entry?.best_score ?? null }
            : null;
          return <ChapterCard key={chapter.id} courseId={courseId} chapter={chapter} learner={learner} />;
        })}
      </ol>
    </>
  );
}

function SignInPrompt({ courseId }: { courseId: string }) {
  const next = `/courses/${encodeURIComponent(courseId)}`;
  return (
    <section className="sign-in-prompt" aria-labelledby="sign-in-prompt-heading">
      <h2 id="sign-in-prompt-heading">Sign in to save your progress and take quizzes</h2>
      <p className="sign-in-actions">
        <Link className="link-action" to={signInPath(next)}>
          Sign in
        </Link>
        <Link className="link-action" to={registerPath(next)}>
          Create account
        </Link>
      </p>
    </section>
  );
}
