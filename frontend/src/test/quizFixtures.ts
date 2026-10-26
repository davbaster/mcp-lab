/**
 * A quiz like the API's, its grading, and its chapter list, for tests of the quiz page and of the
 * feedback dialog that opens from a question. The sentinels are unique strings that must never
 * reach a place they do not belong (see "Security and privacy tests" in _docs/testing-guidelines.md).
 */
import type { RecordedCall } from "./apiRoutes";
import { jsonResponse } from "./mockApi";

export const COURSE = "demo";
export const CHAPTER = "c1";

export const CORRECT = "CORRECT-SENTINEL-7f3a";
export const EXPLANATION = "EXPLANATION-SENTINEL-7f3a";
export const OPTION_ID = "OPTID-SENTINEL-7f3a";

export interface QuizOptions {
  /** Prefix of every option id. */
  tag?: string;
  /** The letters of the options, in the order the API sends them. */
  order?: string[];
  /** The text of the correct option (`a`) of question n. */
  correctText?: (n: number) => string;
  /** Extra keys the real API never sends, put on each question and option. */
  extras?: Record<string, unknown>;
}

/** A quiz like the API's: five questions, the first with a snippet; the correct option is `a`. */
export function makeQuiz({ tag = "", order = ["c", "a", "b"], correctText = (n) => `Q${n} option a`, extras = {} }: QuizOptions = {}) {
  return {
    course_id: COURSE,
    chapter_id: CHAPTER,
    questions: [1, 2, 3, 4, 5].map((n) => ({
      id: `q${n}`,
      text: `Question text ${n}`,
      snippet: n === 1 ? { language: "python", code: "def f():\n    return 1\n" } : null,
      options: order.map((letter) => ({
        id: `${tag}${letter}`,
        text: letter === "a" ? correctText(n) : `Q${n} option ${letter}`,
        ...extras,
      })),
      ...extras,
    })),
    ...extras,
  };
}

export const LESSON_OF = (questionId: string) => (questionId === "q1" || questionId === "q2" ? "l1" : "l2");

/** Grades a request like the server: the correct option ends in `a`, and 4 of 5 pass. */
export function grade(call: RecordedCall, extras: Record<string, unknown> = {}, next: Record<string, unknown> = {}) {
  const answers = (call.body as { answers: { question_id: string; option_id: string }[] }).answers;
  const results = answers.map((a) => ({
    question_id: a.question_id,
    option_id: a.option_id,
    correct_option_id: a.option_id.endsWith("a") ? a.option_id : a.option_id.replace(/.$/, "a"),
    is_correct: a.option_id.endsWith("a"),
    explanation: `${EXPLANATION}-${a.question_id}`,
    lesson_id: LESSON_OF(a.question_id),
  }));
  const score = results.filter((r) => r.is_correct).length;
  const base = { course_id: COURSE, chapter_id: CHAPTER, score, total: 5 };
  if (score >= 4) {
    return { ...base, passed: true, results, next_chapter_id: "c2", course_complete: false, ...next, ...extras };
  }
  const wrong = results.filter((r) => !r.is_correct).map((r) => ({ question_id: r.question_id, lesson_id: r.lesson_id }));
  return { ...base, passed: false, wrong, ...extras };
}

export const chapterList = (status: string | null = "in_progress", chapters: unknown[] | null = null) => ({
  course_id: COURSE,
  chapters: chapters ?? [
    {
      id: "c1",
      title: "Chapter one",
      free_preview: true,
      status,
      lessons: [
        { id: "l1", title: "First lesson" },
        { id: "l2", title: "Second lesson" },
      ],
    },
    {
      id: "c2",
      title: "Chapter two",
      free_preview: false,
      status: "locked",
      lessons: [
        { id: "l3", title: "Third lesson" },
        { id: "l4", title: "Fourth lesson" },
      ],
    },
    { id: "c3", title: "Chapter three", free_preview: false, status: "locked", lessons: [] },
  ],
});


export const QUIZ_URL = `/courses/${COURSE}/chapters/${CHAPTER}/quiz`;

/** The routes the quiz page asks for, for a learner who is signed in and answers with `quiz`. */
export function quizRoutes(quiz: unknown = makeQuiz()) {
  return {
    "GET /api/auth/me": () => jsonResponse({ username: "ada_l" }),
    [`GET /api/courses/${COURSE}/chapters/${CHAPTER}/quiz`]: () => jsonResponse(quiz),
    [`GET /api/courses/${COURSE}/progress`]: () => jsonResponse({ course_id: COURSE, course_complete: false, chapters: [] }),
    [`GET /api/courses/${COURSE}/chapters`]: () => jsonResponse(chapterList("in_progress")),
  };
}
