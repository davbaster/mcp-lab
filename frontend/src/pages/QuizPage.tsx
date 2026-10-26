import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { UNEXPECTED_RESPONSE_MESSAGE, type ApiError } from "../api/apiError";
import { api } from "../api/client";
import { settle } from "../api/settle";
import { signInPath } from "../auth/paths";
import { useAuth } from "../auth/useAuth";
import { PageHeading } from "../components/PageHeading";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { QuizFlow } from "../quiz/QuizFlow";
import { blockedBy, coursePath, readChapters, readQuiz, type Blocked, type ChapterInfo, type Quiz } from "../quiz/quizData";
import "../quiz/quiz.css";

/** What the page shows. It holds no answers: those live in `QuizFlow`, which this page unmounts to start over. */
type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "signIn" }
  | { kind: "locked" }
  | { kind: "notFound"; code: "course_not_found" | "chapter_not_found" }
  | { kind: "changed"; info: ChapterInfo }
  | { kind: "ready"; info: ChapterInfo; quiz: Quiz; focusFirst: boolean };

/** The view for a call that ended the form. A changed quiz (422) can only come from a submit, which has the chapter info. */
function blockedState(blocked: Blocked, info?: ChapterInfo): State {
  if (blocked.kind !== "changed") return blocked;
  return info ? { kind: "changed", info } : { kind: "error", message: UNEXPECTED_RESPONSE_MESSAGE };
}

function SignInPrompt() {
  const location = useLocation();
  return (
    <>
      <p>Sign in to take the quiz</p>
      <Link className="button" to={signInPath(`${location.pathname}${location.search}`)}>
        Sign in
      </Link>
    </>
  );
}

export function QuizPage() {
  const params = useParams();
  const courseId = params.courseId ?? "";
  const chapterId = params.chapterId ?? "";
  const mode = useAuth().status;

  if (mode === "learner") {
    // Keyed by quiz, so another URL starts with nothing of the last quiz.
    return <LearnerQuiz key={`${courseId}/${chapterId}`} courseId={courseId} chapterId={chapterId} />;
  }
  return <WaitingOrVisitor visitor={mode === "visitor"} />;
}

/** While the caller is unknown, and for a visitor: nothing is requested. */
function WaitingOrVisitor({ visitor }: { visitor: boolean }) {
  useDocumentTitle("Quiz");
  return (
    <>
      <PageHeading>Quiz</PageHeading>
      <section className="quiz-region" aria-label="Quiz">
        {visitor ? <SignInPrompt /> : <p role="status">Loading…</p>}
      </section>
    </>
  );
}

function LearnerQuiz({ courseId, chapterId }: { courseId: string; chapterId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const region = useRef<HTMLElement>(null);
  const requestId = useRef(0);

  /** Loads the quiz, and the chapters list unless `reuse` already has it (Try again, Retake, Reload quiz). */
  const load = useCallback(
    async (reuse: ChapterInfo | null, focusFirst: boolean) => {
      const id = ++requestId.current;
      const path = { params: { path: { course_id: courseId, chapter_id: chapterId } } };
      const [quizResult, chaptersResult] = await Promise.all([
        settle(api.GET("/api/courses/{course_id}/chapters/{chapter_id}/quiz", path)),
        reuse ? Promise.resolve(null) : settle(api.GET("/api/courses/{course_id}/chapters", { params: { path: { course_id: courseId } } })),
      ]);

      let next: State;
      const failures: ApiError[] = [quizResult, chaptersResult].flatMap((r) => (r && "failure" in r ? [r.failure] : []));
      if (failures.length > 0) {
        // A reason to leave the form (sign in, locked, not found) wins over a plain failure.
        const blocked = failures.map((failure) => blockedBy(failure)).find((b) => b !== null);
        next = blocked ? blockedState(blocked) : { kind: "error", message: failures[0].message };
      } else {
        const info = reuse ?? (chaptersResult && "data" in chaptersResult ? readChapters(chaptersResult.data, chapterId) : null);
        const quiz = "data" in quizResult ? readQuiz(quizResult.data) : null;
        if (info === "missing") next = { kind: "notFound", code: "chapter_not_found" };
        else if (!info || !quiz) next = { kind: "error", message: UNEXPECTED_RESPONSE_MESSAGE };
        else next = { kind: "ready", info, quiz, focusFirst };
      }
      // Only the newest request may update the page.
      if (id === requestId.current) setState(next);
    },
    [courseId, chapterId],
  );

  useEffect(() => {
    void load(null, false);
    return () => {
      requestId.current += 1;
    };
  }, [load]);

  /** Drops the form (and with it every answer and any review) at once, then fetches a new quiz. */
  function restart(info: ChapterInfo | null) {
    setState({ kind: "loading" });
    // The button is about to be removed, so focus moves to the region that stays.
    region.current?.focus();
    void load(info, true);
  }

  const info = state.kind === "ready" || state.kind === "changed" ? state.info : null;
  const title = info ? `Quiz: ${info.title}` : state.kind === "notFound" ? "Quiz not found" : "Quiz";
  useDocumentTitle(title);

  const backToCourse = (
    <Link className="link-action" to={coursePath(courseId)}>
      Back to course
    </Link>
  );

  return (
    <>
      <PageHeading>{title}</PageHeading>
      <section className="quiz-region" aria-label="Quiz" ref={region} tabIndex={-1}>
        {state.kind === "loading" && <p role="status">Loading…</p>}
        {state.kind === "error" && (
          <div className="error-box" role="alert">
            <p>{state.message}</p>
            <button type="button" className="button" onClick={() => restart(null)}>
              Try again
            </button>
          </div>
        )}
        {state.kind === "signIn" && <SignInPrompt />}
        {state.kind === "locked" && (
          <>
            <p>This chapter is locked. Pass the previous chapter's quiz to unlock it.</p>
            {backToCourse}
          </>
        )}
        {state.kind === "notFound" &&
          (state.code === "course_not_found" ? (
            <Link className="link-action" to="/">
              Back to all courses
            </Link>
          ) : (
            backToCourse
          ))}
        {state.kind === "changed" && (
          <>
            <p>This quiz has changed. Reload it to get the latest version.</p>
            <button type="button" className="button" onClick={() => restart(state.info)}>
              Reload quiz
            </button>
          </>
        )}
        {state.kind === "ready" && (
          <QuizFlow
            courseId={courseId}
            chapterId={chapterId}
            quiz={state.quiz}
            info={state.info}
            focusFirst={state.focusFirst}
            onRestart={(passed) => restart(passed ? { ...state.info, status: "passed" } : state.info)}
            onBlocked={(blocked) => {
              requestId.current += 1;
              setState(blockedState(blocked, state.info));
            }}
          />
        )}
      </section>
    </>
  );
}
