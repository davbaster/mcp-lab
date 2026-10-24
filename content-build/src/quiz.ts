// Checks one chapter's quiz.yaml and compiles it to the data that the backend reads.
//
// A message about a quiz never quotes question text, option text, an explanation, code, or the value of
// `correct`: quiz content is private build data. Messages use ids, counts, line numbers, and file paths.

import quizSchema from "../schemas/quiz.schema.json" with { type: "json" };
import { readText } from "./folder.ts";
import { sortProblems } from "./problem.ts";
import type { Problem } from "./problem.ts";
import type { Report } from "./report.ts";
import { checkShape, compileShape } from "./schema.ts";
import { parseYaml } from "./yaml-file.ts";
import type { ParsedYaml, PathSegment } from "./yaml-file.ts";

/** The limits of a quiz. The JSON Schema checks the shape; these are checked in code. */
export const QUIZ_LIMITS = {
  questions: 5,
  minOptions: 2,
  maxOptions: 3,
  /** Unicode characters, after CRLF becomes LF and the ends are trimmed. */
  explanationLength: 1000,
  /** Unicode characters, after CRLF becomes LF. */
  codeLength: 2000,
} as const;

export type QuizOption = { id: string; text: string };
export type QuizSnippet = { language: string; code: string };
/** The fields are in the order they are written to the file. */
export type QuizQuestion = {
  id: string;
  text: string;
  snippet?: QuizSnippet;
  options: QuizOption[];
  correct: string;
  explanation: string;
  lesson: string;
};
/** What is written to `private/quizzes/<course_id>/<chapter_id>.json`. */
export type CompiledQuiz = { course_id: string; chapter_id: string; questions: QuizQuestion[] };

/** Where a question id was first used. */
export type QuestionSite = { file: string; line: number };

export type QuizOptions = {
  /** The course folder name. */
  courseId: string;
  /** The chapter folder name, such as `03-tools`. */
  chapterId: string;
  /** The ids of the lessons of this chapter. Without them (or with none), the `lesson` links are not checked. */
  lessonIds?: readonly string[];
  /** The question ids of the chapters checked so far in this course, which this call adds to. Without it, ids are unique within the quiz only. */
  questionIds?: Map<string, QuestionSite>;
};

export type QuizResult = { quiz: CompiledQuiz } | { problems: Problem[] };

const ID = /^[a-z0-9-]+$/;
const OPTION_COUNT = `${QUIZ_LIMITS.minOptions} or ${QUIZ_LIMITS.maxOptions}`;

const quizShape = compileShape(quizSchema, { root: "quiz.yaml", quiet: true, lineForMissing: true, locate: locateInQuiz });

/**
 * Checks the text of a quiz.yaml and returns the quiz data, or every problem found (never both). A
 * content error never throws. Reads no file; problems name `chapters/<chapterId>/quiz.yaml`.
 */
export function compileQuiz(text: string, options: QuizOptions): QuizResult {
  const file = `chapters/${options.chapterId}/quiz.yaml`;
  const problems: Problem[] = [];
  const fail = (message: string, line?: number) => {
    problems.push(line === undefined ? { severity: "error", file, message } : { severity: "error", file, line, message });
  };
  const failed = (): QuizResult => ({ problems: sortProblems(problems) });

  const yaml = parseYaml(text);
  if (yaml.errors.length > 0) {
    for (const { line, message } of yaml.errors) fail(`invalid YAML: ${message}`, line);
    return failed();
  }
  const value = yaml.value ?? {};
  if (!isRecord(value)) {
    fail("quiz.yaml must be a mapping of keys to values");
    return failed();
  }
  for (const { line, message } of checkShape(quizShape, value, yaml)) fail(message, line);
  const questions = value.questions;
  if (Array.isArray(questions)) checkRules(questions, yaml, { ...options, file }, fail);
  if (problems.length > 0) return failed();
  return { quiz: build(questions as Record<string, unknown>[], options) };
}

type Fail = (message: string, line?: number) => void;

function checkRules(questions: unknown[], yaml: ParsedYaml, options: QuizOptions & { file: string }, fail: Fail) {
  if (questions.length !== QUIZ_LIMITS.questions) {
    fail(`the quiz must have exactly ${QUIZ_LIMITS.questions} questions but has ${questions.length}`, yaml.lineOf(["questions"]));
  }
  const seenIds = options.questionIds ?? new Map<string, QuestionSite>();
  const lessonIds = options.lessonIds !== undefined && options.lessonIds.length > 0 ? options.lessonIds : undefined;

  questions.forEach((question, index) => {
    if (!isRecord(question)) return;
    const name = questionName(question, index);
    const lineOf = (...path: PathSegment[]) => yaml.lineOf(["questions", index, ...path]);

    const id = idOf(question.id);
    if (id !== undefined) {
      const first = seenIds.get(id);
      if (first === undefined) {
        seenIds.set(id, { file: options.file, line: lineOf("id") ?? 0 });
      } else {
        fail(`${name}: the id is already used by the question at ${first.file}:${first.line}`, lineOf("id"));
      }
    }

    if (Array.isArray(question.options)) checkOptions(question, question.options, name, lineOf, fail);

    const { explanation, snippet, lesson } = question;
    if (isFilled(explanation)) {
      const length = characters(final(explanation));
      if (length > QUIZ_LIMITS.explanationLength) {
        fail(`${name}: \`explanation\` has ${length} characters; the limit is ${QUIZ_LIMITS.explanationLength}`, lineOf("explanation"));
      }
    }
    if (isRecord(snippet) && isFilled(snippet.code)) {
      const length = characters(lineEndings(snippet.code));
      if (length > QUIZ_LIMITS.codeLength) {
        fail(`${name}, snippet: \`code\` has ${length} characters; the limit is ${QUIZ_LIMITS.codeLength}`, lineOf("snippet", "code"));
      }
    }
    if (lessonIds !== undefined && isFilled(lesson) && !lessonIds.includes(lesson)) {
      fail(`${name}: \`lesson\` is \`${lesson}\`, but this chapter has no lesson with that id`, lineOf("lesson"));
    }
  });
}

type LineOf = (...path: PathSegment[]) => number | undefined;

function checkOptions(question: Record<string, unknown>, list: unknown[], name: string, lineOf: LineOf, fail: Fail) {
  if (list.length < QUIZ_LIMITS.minOptions || list.length > QUIZ_LIMITS.maxOptions) {
    fail(`${name}: must have ${OPTION_COUNT} options but has ${list.length}`, lineOf("options"));
  }
  const firstWithId = new Map<string, number>();
  const firstWithText = new Map<string, number>();
  list.forEach((option, index) => {
    if (!isRecord(option)) return;
    const id = idOf(option.id);
    if (id !== undefined) {
      const first = firstWithId.get(id);
      if (first === undefined) {
        firstWithId.set(id, index);
      } else {
        fail(
          `${name}: option id \`${id}\` is already used by the option on line ${lineOf("options", first, "id") ?? "?"}`,
          lineOf("options", index, "id"),
        );
      }
    }
    if (isFilled(option.text)) {
      const text = final(option.text);
      const first = firstWithText.get(text);
      if (first === undefined) {
        firstWithText.set(text, index);
      } else if (id === undefined || idOf((list[first] as Record<string, unknown>).id) !== id) {
        // The same id and the same text is reported once, as a repeated id.
        fail(
          `${name}: ${optionName(list[first], first)} and ${optionName(option, index)} have the same text`,
          lineOf("options", index, "text"),
        );
      }
    }
  });

  const { correct } = question;
  if (typeof correct === "string") {
    const matches = list.filter((option) => isRecord(option) && option.id === correct).length;
    // Two matches are two options with one id, which is reported above.
    if (matches === 0) fail(`${name}: \`correct\` does not match the id of any option`, lineOf("correct"));
  }
}

/** The data to write. Only called for a quiz without problems, so every field has its type. */
function build(questions: Record<string, unknown>[], options: QuizOptions): CompiledQuiz {
  return {
    course_id: options.courseId,
    chapter_id: options.chapterId,
    questions: questions.map((question) => {
      const snippet = question.snippet as QuizSnippet | undefined;
      const choices = question.options as QuizOption[];
      return {
        id: question.id as string,
        text: final(question.text as string),
        ...(snippet === undefined ? {} : { snippet: { language: snippet.language, code: lineEndings(snippet.code) } }),
        options: choices.map((option) => ({ id: option.id, text: final(option.text) })),
        correct: question.correct as string,
        explanation: final(question.explanation as string),
        lesson: question.lesson as string,
      };
    }),
  };
}

/** What the quizzes of a course gather while its chapters are checked one after another. */
export type QuizCollector = {
  courseId: string;
  questionIds: Map<string, QuestionSite>;
  /** The quizzes that had no problem, in chapter order. */
  quizzes: CompiledQuiz[];
  /** Every problem of every quiz.yaml, including a missing or unreadable one. */
  problems: Problem[];
};

export function makeQuizCollector(courseId: string): QuizCollector {
  return { courseId, questionIds: new Map(), quizzes: [], problems: [] };
}

/** Reads the quiz.yaml at `path` (shown as `file`) of one chapter, and adds what it finds to the report and the collector. */
export function checkQuizFile(
  path: string,
  file: string,
  chapterId: string,
  lessonIds: readonly string[] | undefined,
  collector: QuizCollector,
  report: Report,
) {
  const read = readText(path);
  const result: QuizResult =
    "error" in read
      ? { problems: [{ severity: "error", file, message: read.error }] }
      : compileQuiz(read.text, { courseId: collector.courseId, chapterId, lessonIds, questionIds: collector.questionIds });
  if ("quiz" in result) {
    collector.quizzes.push(result.quiz);
    return;
  }
  report.problems.push(...result.problems);
  collector.problems.push(...result.problems);
}

// Names, as the messages use them: by id when there is a usable one, otherwise by position.

function idOf(value: unknown): string | undefined {
  return typeof value === "string" && ID.test(value) ? value : undefined;
}

function questionName(question: unknown, index: number): string {
  const id = isRecord(question) ? idOf(question.id) : undefined;
  return id === undefined ? `question ${index + 1}` : `question \`${id}\``;
}

function optionName(option: unknown, index: number): string {
  const id = isRecord(option) ? idOf(option.id) : undefined;
  return id === undefined ? `option ${index + 1}` : `option \`${id}\``;
}

/** Splits a path inside quiz.yaml into the part it belongs to (a question, an option, a snippet) and the rest. */
function locateInQuiz(path: readonly PathSegment[], root: unknown): { scope: string; rest: PathSegment[] } {
  const [top, index, ...inner] = path;
  if (top !== "questions" || typeof index !== "number") return { scope: "", rest: [...path] };
  const question = isRecord(root) && Array.isArray(root.questions) ? (root.questions[index] as unknown) : undefined;
  const name = questionName(question, index);
  const [part, position, ...rest] = inner;
  if (part === "options" && typeof position === "number") {
    const list = isRecord(question) && Array.isArray(question.options) ? (question.options as unknown[]) : [];
    return { scope: `${name}, ${optionName(list[position], position)}`, rest };
  }
  if (part === "snippet" && position !== undefined) return { scope: `${name}, snippet`, rest: [position, ...rest] };
  return { scope: name, rest: inner };
}

// Text: CRLF becomes LF; the text of a question, an option, and an explanation is also trimmed.

function lineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

function final(text: string): string {
  return lineEndings(text).trim();
}

/** Counts Unicode characters, so a character outside the Basic Multilingual Plane counts once. */
function characters(text: string): number {
  return [...text].length;
}

function isFilled(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
