// The stable IDs of a course (chapters, lessons, questions): `ids.json`, which is generated and checked in.

import type { Inspection } from "./course.ts";
import { jsonText } from "./write-course.ts";

export const KINDS = ["chapter", "lesson", "question"] as const;
export type Kind = (typeof KINDS)[number];

/** The content of `courses/<id>/ids.json`, with the keys in the order they are written. */
export type CourseIds = {
  course_id: string;
  /** In the order of `course.yaml`. */
  chapters: string[];
  /** By chapter, then by `order`. */
  lessons: string[];
  /** By chapter, then by position in the quiz. */
  questions: string[];
};

/** The list of IDs of one kind. */
export function idsOfKind(ids: Omit<CourseIds, "course_id">, kind: Kind): string[] {
  return kind === "chapter" ? ids.chapters : kind === "lesson" ? ids.lessons : ids.questions;
}

/** The IDs of a checked course, or undefined when the check did not find everything (the course has errors). Only listed chapters count. */
export function courseIds(courseId: string, inspection: Inspection): CourseIds | undefined {
  const { chapters, lessons, quizzes } = inspection;
  if (chapters === undefined || lessons === undefined || quizzes === undefined) return undefined;
  return {
    course_id: courseId,
    chapters: [...chapters],
    lessons: lessons.map((lesson) => lesson.id),
    questions: chapters.flatMap((chapter) => quizzes.quizzes.find((quiz) => quiz.chapter_id === chapter)?.questions.map((question) => question.id) ?? []),
  };
}

/** The text of `ids.json`: the same format as every JSON file of the build. */
export function idsText(ids: CourseIds): string {
  return jsonText(ids);
}

/**
 * The lists of an `ids.json` that was read from disk, in whatever line ending and with or without a byte order
 * mark, or why it cannot be read. A missing list counts as empty (the placeholder `{}` is such a file).
 */
export function parseIds(text: string): { ids: CourseIds } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text);
  } catch {
    return { error: "it is not valid JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { error: "it is not a JSON object" };
  const record = value as Record<string, unknown>;
  const list = (key: string): string[] | undefined => {
    const found = record[key];
    if (found === undefined) return [];
    return Array.isArray(found) && found.every((item) => typeof item === "string") ? (found as string[]) : undefined;
  };
  const chapters = list("chapters");
  const lessons = list("lessons");
  const questions = list("questions");
  if (chapters === undefined || lessons === undefined || questions === undefined) return { error: "`chapters`, `lessons`, and `questions` must each be a list of strings" };
  return { ids: { course_id: typeof record.course_id === "string" ? record.course_id : "", chapters, lessons, questions } };
}

/** True when two files hold the same IDs and the same `course_id`, and no other key. */
export function sameIds(text: string, expected: CourseIds): boolean {
  let value: unknown;
  try {
    value = JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text);
  } catch {
    return false;
  }
  return JSON.stringify(sortedKeys(value)) === JSON.stringify(sortedKeys(expected));
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, sortedKeys(item)]),
  );
}

/** A short description of how `found` (read from ids.json) differs from `expected` (what the course has now). */
export function describeDifference(found: CourseIds | undefined, expected: CourseIds): string {
  if (found === undefined) return "it cannot be compared";
  const parts: string[] = [];
  if (found.course_id !== expected.course_id) {
    parts.push(found.course_id === "" ? `\`course_id\` is missing` : `\`course_id\` is \`${found.course_id}\` but should be \`${expected.course_id}\``);
  }
  for (const kind of KINDS) {
    const now = idsOfKind(expected, kind);
    const written = idsOfKind(found, kind);
    const missing = now.filter((id) => !written.includes(id));
    const extra = written.filter((id) => !now.includes(id));
    if (missing.length > 0) parts.push(`it lacks ${kind} ${list(missing)}`);
    if (extra.length > 0) parts.push(`it has ${kind} ${list(extra)} that the course does not have`);
    if (missing.length === 0 && extra.length === 0 && now.join("\n") !== written.join("\n")) parts.push(`the ${kind} IDs are in a different order`);
  }
  return parts.length > 0 ? parts.join("; ") : "it has other keys, or the lists are not in the generated order";
}

function list(ids: readonly string[]): string {
  const shown = ids.slice(0, 5).map((id) => `\`${id}\``);
  return ids.length > 5 ? `${shown.join(", ")} and ${ids.length - 5} more` : shown.join(", ");
}
