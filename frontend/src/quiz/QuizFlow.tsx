import { useEffect, useRef, useState } from "react";
import { UNEXPECTED_RESPONSE_MESSAGE } from "../api/apiError";
import { api } from "../api/client";
import { settle } from "../api/settle";
import { isRecord } from "../content-components/tree";
import { FailedReview } from "./FailedReview";
import { PassedReview, readPassed, type PassedAttempt } from "./PassedReview";
import { QuizForm } from "./QuizForm";
import { blockedBy, readFailed, type Blocked, type ChapterInfo, type FailedAttempt, type Quiz } from "./quizData";

type Outcome = { kind: "failed"; attempt: FailedAttempt } | { kind: "passed"; attempt: PassedAttempt };

/**
 * One go at one quiz: the picked options, the submit, and what the server said. Everything is
 * React state of this component; the page unmounts it to start over, so nothing outlives a retake.
 */
export function QuizFlow({
  courseId,
  chapterId,
  quiz,
  info,
  focusFirst,
  onRestart,
  onBlocked,
}: {
  courseId: string;
  chapterId: string;
  quiz: Quiz;
  info: ChapterInfo;
  /** Move focus to the first question once it is shown (after Try again or Reload quiz). */
  focusFirst: boolean;
  /** Fetch a new quiz. `passed` says this go ended in a pass. */
  onRestart: (passed: boolean) => void;
  onBlocked: (blocked: Blocked) => void;
}) {
  const [choices, setChoices] = useState<(number | null)[]>(() => quiz.questions.map(() => null));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const firstQuestion = useRef<HTMLFieldSetElement>(null);
  // Set at once on the first click, before React shows the disabled button, so a double click sends one request.
  const sending = useRef(false);
  const attempt = useRef(0);

  useEffect(() => {
    if (focusFirst) firstQuestion.current?.focus();
  }, [focusFirst]);

  // An answer that arrives after this component has gone is dropped.
  useEffect(
    () => () => {
      attempt.current += 1;
    },
    [],
  );

  function choose(question: number, option: number) {
    setChoices((current) => current.map((choice, index) => (index === question ? option : choice)));
  }

  async function submit() {
    if (sending.current || outcome !== null) return;
    const picked = choices.map((choice, index) => (choice === null ? null : quiz.questions[index].options[choice]));
    if (picked.some((option) => option === null)) return;
    sending.current = true;
    setSubmitting(true);
    setError(null);
    const id = ++attempt.current;

    const result = await settle(
      api.POST("/api/courses/{course_id}/chapters/{chapter_id}/quiz/attempts", {
        params: { path: { course_id: courseId, chapter_id: chapterId } },
        body: { answers: quiz.questions.map((question, index) => ({ question_id: question.id, option_id: picked[index]!.id })) },
      }),
    );
    if (id !== attempt.current) return;
    sending.current = false;

    if ("failure" in result) {
      const blocked = blockedBy(result.failure, true);
      if (blocked) onBlocked(blocked);
      else {
        setSubmitting(false);
        setError(result.failure.message);
      }
      return;
    }

    const data: unknown = result.data;
    if (isRecord(data) && data.passed === true) {
      const read = readPassed(data);
      if (read) return setOutcome({ kind: "passed", attempt: read });
    } else if (isRecord(data) && data.passed === false) {
      const read = readFailed(data);
      if (read) return setOutcome({ kind: "failed", attempt: read });
    }
    // Neither a pass nor a fail the page understands: the answers stay and the learner can send again.
    setSubmitting(false);
    setError(UNEXPECTED_RESPONSE_MESSAGE);
  }

  if (outcome?.kind === "failed") {
    return (
      <FailedReview
        courseId={courseId}
        quiz={quiz}
        choices={choices as number[]}
        attempt={outcome.attempt}
        info={info}
        alreadyPassed={info.status === "passed"}
        onTryAgain={() => onRestart(false)}
      />
    );
  }
  if (outcome?.kind === "passed") {
    return <PassedReview courseId={courseId} quiz={quiz} attempt={outcome.attempt} info={info} onRetake={() => onRestart(true)} />;
  }
  return (
    <QuizForm
      quiz={quiz}
      choices={choices}
      submitting={submitting}
      error={error}
      firstQuestion={firstQuestion}
      onChoose={choose}
      onSubmit={() => void submit()}
    />
  );
}
