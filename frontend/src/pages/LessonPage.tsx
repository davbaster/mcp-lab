import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { UNEXPECTED_RESPONSE_MESSAGE, type ApiError } from "../api/apiError";
import { api } from "../api/client";
import { settle } from "../api/settle";
import { signInPath } from "../auth/paths";
import { useAuth } from "../auth/useAuth";
import { PageHeading } from "../components/PageHeading";
import { LessonContent } from "../content-components/LessonContent";
import { isLessonTree, isRecord, type LessonTree } from "../content-components/tree";
import { useDocumentTitle } from "../lib/useDocumentTitle";

interface Lesson {
  title: string;
  chapterId: string;
  lessonId: string;
  prevLessonId: string | null;
  nextLessonId: string | null;
  tree: LessonTree;
}

/** `key` says which caller and lesson the answer is for, so a stale one is ignored. */
type State =
  | { kind: "loading" }
  | { kind: "error"; key: string; message: string }
  | { kind: "signIn"; key: string }
  | { kind: "locked"; key: string }
  | { kind: "notFound"; key: string }
  | { kind: "loaded"; key: string; lesson: Lesson };

const isString = (value: unknown): value is string => typeof value === "string";
const isIdOrNull = (value: unknown): value is string | null => value === null || isString(value);

/** The lesson answer, checked at run time (the API types `tree` as `unknown`); null if it is not one. */
function readLesson(data: unknown): Lesson | null {
  if (!isRecord(data)) return null;
  const { title, chapter_id, lesson_id, prev_lesson_id, next_lesson_id, tree } = data;
  if (!isString(title) || !isString(chapter_id) || !isString(lesson_id)) return null;
  if (!isIdOrNull(prev_lesson_id) || !isIdOrNull(next_lesson_id) || !isLessonTree(tree)) return null;
  return { title, chapterId: chapter_id, lessonId: lesson_id, prevLessonId: prev_lesson_id, nextLessonId: next_lesson_id, tree };
}

function failureState(failure: ApiError, key: string): State {
  if (failure.status === 401 && failure.code === "not_authenticated") return { kind: "signIn", key };
  if (failure.status === 403 && failure.code === "chapter_locked") return { kind: "locked", key };
  if (failure.status === 404 && (failure.code === "lesson_not_found" || failure.code === "course_not_found")) {
    return { kind: "notFound", key };
  }
  return { kind: "error", key, message: failure.message };
}

const coursePath = (courseId: string) => `/courses/${encodeURIComponent(courseId)}`;
const lessonPath = (courseId: string, lessonId: string) => `${coursePath(courseId)}/lessons/${encodeURIComponent(lessonId)}`;
const quizPath = (courseId: string, chapterId: string) =>
  `${coursePath(courseId)}/chapters/${encodeURIComponent(chapterId)}/quiz`;

export function LessonPage() {
  const params = useParams();
  const courseId = params.courseId ?? "";
  const lessonId = params.lessonId ?? "";
  const location = useLocation();
  const mode = useAuth().status;
  const key = `${mode}:${courseId}:${lessonId}`;
  const [state, setState] = useState<State>({ kind: "loading" });
  const region = useRef<HTMLElement>(null);
  const requestId = useRef(0);
  const savedFor = useRef<string | null>(null);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    const result = await settle(
      api.GET("/api/courses/{course_id}/lessons/{lesson_id}", {
        params: { path: { course_id: courseId, lesson_id: lessonId } },
      }),
    );
    let next: State;
    if ("failure" in result) {
      next = failureState(result.failure, key);
    } else {
      const lesson = readLesson(result.data);
      next = lesson ? { kind: "loaded", key, lesson } : { kind: "error", key, message: UNEXPECTED_RESPONSE_MESSAGE };
    }
    // Only the newest request may update the page.
    if (id === requestId.current) setState(next);
  }, [courseId, lessonId, key]);

  useEffect(() => {
    if (mode === "loading") return;
    void load();
    return () => {
      requestId.current += 1;
    };
  }, [load, mode]);

  // An answer for another lesson, or for a caller who has since changed, is not shown.
  const current = state.kind !== "loading" && state.key === key && mode !== "loading" ? state : null;
  const loadedLesson = current?.kind === "loaded" ? current.lesson : null;

  // Remember where a signed-in learner is, once for each lesson view. Nothing is shown if it fails.
  const saveLesson = mode === "learner" ? (loadedLesson?.lessonId ?? null) : null;
  useEffect(() => {
    if (saveLesson === null) return;
    const view = `${courseId}/${saveLesson}`;
    // Also once under StrictMode's second run of this effect.
    if (savedFor.current === view) return;
    savedFor.current = view;
    api
      .PUT("/api/courses/{course_id}/progress/last-lesson", {
        params: { path: { course_id: courseId } },
        body: { lesson_id: saveLesson },
      })
      .catch(() => undefined);
  }, [courseId, saveLesson]);

  function tryAgain() {
    setState({ kind: "loading" });
    // The button is about to be removed, so focus moves to the region that stays.
    region.current?.focus();
    void load();
  }

  const title = loadedLesson ? loadedLesson.title : current?.kind === "notFound" ? "Lesson not found" : "Lesson";
  useDocumentTitle(title);

  const backToCourse = (
    <Link className="link-action" to={coursePath(courseId)}>
      Back to course
    </Link>
  );

  return (
    <>
      <PageHeading>{title}</PageHeading>
      <section className="lesson-region" aria-label="Lesson" ref={region} tabIndex={-1}>
        {!current && <p role="status">Loading…</p>}
        {current?.kind === "error" && (
          <div role="alert">
            <p>{current.message}</p>
            <button type="button" className="button" onClick={tryAgain}>
              Try again
            </button>
          </div>
        )}
        {current?.kind === "signIn" && (
          <>
            <p>Sign in to read this lesson</p>
            <Link className="button" to={signInPath(`${location.pathname}${location.search}`)}>
              Sign in
            </Link>
          </>
        )}
        {current?.kind === "locked" && (
          <>
            <p>This chapter is locked. Pass the previous chapter's quiz to unlock it.</p>
            {backToCourse}
          </>
        )}
        {current?.kind === "notFound" && backToCourse}
        {loadedLesson && (
          <>
            {/* Keyed by lesson, so nothing of the last lesson's content lingers. The `h1` has no key. */}
            <LessonContent
              key={`${courseId}/${loadedLesson.lessonId}`}
              tree={loadedLesson.tree}
              title={loadedLesson.title}
              lesson={{ courseId, chapterId: loadedLesson.chapterId }}
            />
            <LessonNav courseId={courseId} lesson={loadedLesson} learner={mode === "learner"} />
          </>
        )}
      </section>
    </>
  );
}

function LessonNav({ courseId, lesson, learner }: { courseId: string; lesson: Lesson; learner: boolean }) {
  const quiz = quizPath(courseId, lesson.chapterId);
  return (
    <nav className="lesson-nav" aria-label="Lesson navigation">
      {lesson.prevLessonId !== null ? (
        <Link className="button button-secondary" to={lessonPath(courseId, lesson.prevLessonId)}>
          Previous lesson
        </Link>
      ) : (
        <Link className="button button-secondary" to={coursePath(courseId)}>
          Back to course
        </Link>
      )}
      {lesson.nextLessonId !== null ? (
        <Link className="button" to={lessonPath(courseId, lesson.nextLessonId)}>
          Next lesson
        </Link>
      ) : learner ? (
        <Link className="button" to={quiz}>
          Take the chapter quiz
        </Link>
      ) : (
        <Link className="button" to={signInPath(quiz)}>
          Sign in to take the quiz
        </Link>
      )}
    </nav>
  );
}
