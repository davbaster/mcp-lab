import type { ApiError } from "../api/apiError";
import { isRecord } from "../content-components/tree";

/** What the page reads of the quiz `GET`: ids, texts and the snippet's code and language. Nothing else. */
export interface QuizOption {
  id: string;
  text: string;
}

export interface QuizQuestion {
  id: string;
  text: string;
  /** The snippet's code, or null when the question has none. */
  code: string | null;
  /** The snippet's language as written, or null when it has none; the page highlights the ones it knows. */
  language: string | null;
  options: QuizOption[];
}

export interface Quiz {
  questions: QuizQuestion[];
}

const isString = (value: unknown): value is string => typeof value === "string";

function readOption(value: unknown): QuizOption | null {
  if (!isRecord(value) || !isString(value.id) || !isString(value.text)) return null;
  return { id: value.id, text: value.text };
}

function readQuestion(value: unknown): QuizQuestion | null {
  if (!isRecord(value) || !isString(value.id) || !isString(value.text) || !Array.isArray(value.options)) return null;
  const options = value.options.map(readOption);
  if (options.length === 0 || options.some((option) => option === null)) return null;
  let code: string | null = null;
  let language: string | null = null;
  if (value.snippet !== null && value.snippet !== undefined) {
    if (!isRecord(value.snippet) || !isString(value.snippet.code)) return null;
    code = value.snippet.code === "" ? null : value.snippet.code;
    // A bad language never makes the quiz unusable: the snippet is plain text.
    if (code !== null && isString(value.snippet.language) && value.snippet.language !== "") language = value.snippet.language;
  }
  return { id: value.id, text: value.text, code, language, options: options as QuizOption[] };
}

/** The quiz, checked at run time; null if the body is not a quiz with at least one answerable question. */
export function readQuiz(data: unknown): Quiz | null {
  if (!isRecord(data) || !Array.isArray(data.questions) || data.questions.length === 0) return null;
  const questions = data.questions.map(readQuestion);
  if (questions.some((question) => question === null)) return null;
  return { questions: questions as QuizQuestion[] };
}

export type ChapterStatus = "locked" | "in_progress" | "passed";

/** What the page needs from the chapters list. */
export interface ChapterInfo {
  title: string;
  status: ChapterStatus | null;
  /** Every lesson of the course, by id. */
  lessonTitles: ReadonlyMap<string, string>;
  /** The first lesson of each chapter that has one, by chapter id. */
  firstLessons: ReadonlyMap<string, string>;
}

/** The info for `chapterId`, "missing" if the list does not have it, null if the body is not a chapters list. */
export function readChapters(data: unknown, chapterId: string): ChapterInfo | "missing" | null {
  if (!isRecord(data) || !Array.isArray(data.chapters)) return null;
  const lessonTitles = new Map<string, string>();
  const firstLessons = new Map<string, string>();
  let found: { title: string; status: ChapterStatus | null } | null = null;

  for (const chapter of data.chapters as unknown[]) {
    if (!isRecord(chapter) || !isString(chapter.id) || !isString(chapter.title)) continue;
    const lessons = Array.isArray(chapter.lessons) ? (chapter.lessons as unknown[]) : [];
    let first = true;
    for (const lesson of lessons) {
      if (!isRecord(lesson) || !isString(lesson.id) || !isString(lesson.title)) continue;
      if (!lessonTitles.has(lesson.id)) lessonTitles.set(lesson.id, lesson.title);
      if (first) firstLessons.set(chapter.id, lesson.id);
      first = false;
    }
    if (chapter.id === chapterId && found === null) {
      const status = chapter.status;
      found = {
        title: chapter.title,
        status: status === "locked" || status === "in_progress" || status === "passed" ? status : null,
      };
    }
  }
  return found ? { ...found, lessonTitles, firstLessons } : "missing";
}

/** The ways a call can end the quiz view, whichever call it is. */
export type Blocked =
  | { kind: "signIn" }
  | { kind: "locked" }
  | { kind: "notFound"; code: "course_not_found" | "chapter_not_found" }
  | { kind: "changed" };

/** `changed` (a 422) is only meaningful for the attempt `POST`. */
export function blockedBy(failure: ApiError, submitting = false): Blocked | null {
  if (failure.status === 401 && failure.code === "not_authenticated") return { kind: "signIn" };
  if (failure.status === 403 && failure.code === "chapter_locked") return { kind: "locked" };
  if (failure.status === 404 && (failure.code === "course_not_found" || failure.code === "chapter_not_found")) {
    return { kind: "notFound", code: failure.code };
  }
  if (submitting && failure.status === 422) return { kind: "changed" };
  return null;
}

/**
 * A failed attempt as the page keeps it: the score, and which questions to review. The server sends
 * nothing else that matters here, and the page reads nothing else.
 */
export interface FailedAttempt {
  score: number;
  total: number;
  /** Question id to lesson id. */
  wrong: ReadonlyMap<string, string>;
}

/** The failed attempt, checked at run time; null if the body is not one. Reads four fields only. */
export function readFailed(data: Record<string, unknown>): FailedAttempt | null {
  const { score, total, wrong } = data;
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  if (typeof total !== "number" || !Number.isFinite(total) || !Array.isArray(wrong)) return null;
  const byQuestion = new Map<string, string>();
  for (const entry of wrong as unknown[]) {
    if (!isRecord(entry) || typeof entry.question_id !== "string" || typeof entry.lesson_id !== "string") return null;
    byQuestion.set(entry.question_id, entry.lesson_id);
  }
  return { score, total, wrong: byQuestion };
}

export const coursePath = (courseId: string) => `/courses/${encodeURIComponent(courseId)}`;
export const lessonPath = (courseId: string, lessonId: string) =>
  `${coursePath(courseId)}/lessons/${encodeURIComponent(lessonId)}`;
