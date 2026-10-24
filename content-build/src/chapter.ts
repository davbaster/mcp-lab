// Checks one listed chapter folder: its lessons/ folder, its quiz.yaml, and the lesson front matter.

import { join } from "node:path";
import { listFolder, readText } from "./folder.ts";
import type { Problem } from "./problem.ts";
import { checkQuizFile } from "./quiz.ts";
import type { QuizCollector } from "./quiz.ts";
import { checkKnownEntries } from "./report.ts";
import type { EntrySpec, Report } from "./report.ts";
import { checkShape, lessonFrontMatterShape } from "./schema.ts";
import { parseYaml, stripBom } from "./yaml-file.ts";
import type { ParsedYaml } from "./yaml-file.ts";
import { isWindowsDeviceName } from "./windows-paths.ts";

const LESSON_FILE = /^(\d{2})-[a-z0-9-]+\.mdx$/;
const LESSON_ID = /^[a-z0-9-]+$/;

/** Compiles one lesson, given its text and its file inside the course, and returns the problems it has. */
export type LessonChecker = (text: string, file: string) => Problem[];

/** A lesson file of a chapter, with what its front matter says (when the front matter could be read). */
export type Lesson = {
  /** The file name, such as `01-intro.mdx`. */
  name: string;
  /** The file inside the course, such as `chapters/01-intro/lessons/01-intro.mdx`. */
  file: string;
  /** The lesson's stable ID: see `lessonId`. */
  id: string;
  /** The line of the explicit `id` in the front matter, when the lesson has a valid one. */
  idLine?: number;
  /** The lesson's `title`, when it is a valid one. */
  title?: string;
  /** The lesson's `order`, when it is a valid one. */
  order?: number;
  orderLine?: number;
};

/**
 * `folder` is the chapter on disk, `file` the same folder inside the course, as used in messages. With
 * `quiz`, the chapter's quiz.yaml is checked too (it needs the lesson IDs, so it comes after the lessons).
 * With `checkLesson`, every lesson whose front matter block is found is compiled too. Returns the lessons
 * (in file name order), or undefined when the lessons/ folder is missing, unreadable, or has no lesson.
 */
export function validateChapter(
  folder: string,
  file: string,
  spec: EntrySpec,
  report: Report,
  quiz?: { collector: QuizCollector; chapterId: string },
  checkLesson?: LessonChecker,
): Lesson[] | undefined {
  const found = listFolder(folder);
  if (found === undefined) {
    report.error(file, "the chapter folder cannot be read");
    return undefined;
  }
  checkKnownEntries(report, file, found, spec, "chapter");

  let lessons: Lesson[] | undefined;
  if (found.get("lessons") === "directory") {
    lessons = validateLessons(join(folder, "lessons"), `${file}/lessons`, report, checkLesson);
  } else {
    report.error(`${file}/lessons`, "the lessons/ folder is missing");
  }

  const quizFile = `${file}/quiz.yaml`;
  if (found.get("quiz.yaml") !== "file") {
    report.error(quizFile, "quiz.yaml is missing");
    quiz?.collector.problems.push({ severity: "error", file: quizFile, message: "quiz.yaml is missing" });
  } else if (quiz !== undefined) {
    checkQuizFile(join(folder, "quiz.yaml"), quizFile, quiz.chapterId, lessons?.map((lesson) => lesson.id), quiz.collector, report);
  }
  return lessons;
}

/** The lessons, or undefined when there are none to link to. */
function validateLessons(folder: string, file: string, report: Report, checkLesson?: LessonChecker): Lesson[] | undefined {
  const found = listFolder(folder);
  if (found === undefined) {
    report.error(file, "the lessons/ folder cannot be read");
    return undefined;
  }
  const lessons: Lesson[] = [];
  for (const [name, kind] of found) {
    if (kind !== "file" || !name.endsWith(".mdx")) {
      const what = kind === "directory" ? "folder" : "file";
      report.warning(`${file}/${name}`, `this ${what} is ignored; lessons/ holds only .mdx lesson files`);
      continue;
    }
    lessons.push(readLesson(join(folder, name), `${file}/${name}`, name, report, checkLesson));
  }
  if (lessons.length === 0) {
    report.error(file, "lessons/ must contain at least one .mdx lesson file");
    return undefined;
  }
  checkOrders(lessons, file, report);
  return lessons;
}

function readLesson(path: string, file: string, name: string, report: Report, checkLesson?: LessonChecker): Lesson {
  const lesson: Lesson = { name, file, id: lessonId(name, undefined) };
  if (!LESSON_FILE.test(name)) {
    report.error(
      file,
      "lesson file names must be NN-slug.mdx: two digits, a hyphen, then lowercase letters, digits, and hyphens",
    );
  }
  const read = readText(path);
  if ("error" in read) {
    report.error(file, read.error);
    return lesson;
  }
  const front = splitFrontMatter(read.text);
  if ("problem" in front) {
    report.error(file, front.problem, 1);
    return lesson;
  }
  // What the front matter holds is checked below; the body is compiled whatever the front matter holds.
  if (checkLesson !== undefined) report.problems.push(...checkLesson(read.text, file));
  const yaml = parseYaml(front.yaml, 2);
  if (yaml.errors.length > 0) {
    for (const { line, message } of yaml.errors) report.error(file, `invalid YAML in the front matter: ${message}`, line);
    return lesson;
  }
  const value = yaml.value ?? {};
  if (typeof value !== "object" || Array.isArray(value)) {
    report.error(file, "the front matter must be a mapping of keys to values", 2);
    return lesson;
  }
  for (const { line, message } of checkShape(lessonFrontMatterShape, value, yaml)) {
    report.error(file, message, line);
  }
  const data = value as Record<string, unknown>;
  const id = lessonId(name, value);
  const explicit = typeof data.id === "string" && LESSON_ID.test(data.id);
  if (explicit && isWindowsDeviceName(id)) {
    report.error(
      file,
      `the lesson \`id\` \`${id}\` is a Windows device name, and the id becomes a file name in the build (\`${id}.json\`); choose another id`,
      yaml.lineOf(["id"]),
    );
  }
  const title = typeof data.title === "string" && /\S/.test(data.title) ? { title: data.title } : {};
  return withOrder({ ...lesson, ...title, id, ...(explicit ? { idLine: yaml.lineOf(["id"]) } : {}) }, data, yaml);
}

/**
 * The stable ID of a lesson: the `id` in its front matter when that is a valid one, otherwise the file
 * name without `.mdx`. `frontMatter` is the parsed front matter, or undefined when there is none.
 */
export function lessonId(fileName: string, frontMatter: unknown): string {
  const id = typeof frontMatter === "object" && frontMatter !== null ? (frontMatter as Record<string, unknown>).id : undefined;
  return typeof id === "string" && LESSON_ID.test(id) ? id : fileName.replace(/\.mdx$/, "");
}

function withOrder(lesson: Lesson, data: Record<string, unknown>, yaml: ParsedYaml): Lesson {
  const order = data.order;
  if (typeof order !== "number" || !Number.isInteger(order) || order < 1) return lesson;
  return { ...lesson, order, orderLine: yaml.lineOf(["order"]) };
}

/**
 * The text between the opening and closing `---` lines, and the line number of the closing one (the
 * body starts on the next line), or why there is no front matter block.
 */
export function splitFrontMatter(text: string): { yaml: string; closingLine: number } | { problem: string } {
  const lines = stripBom(text).split("\n").map((l) => l.replace(/\r$/, ""));
  if (lines[0]?.trimEnd() !== "---") {
    return { problem: "the lesson must start with a front-matter block: a `---` line, the settings, and a closing `---` line" };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end === -1) return { problem: "the front matter that starts here has no closing `---` line" };
  return { yaml: lines.slice(1, end).join("\n"), closingLine: end + 1 };
}

/** `order` values are unique and run 1..N; a file-name prefix that disagrees with `order` is a warning. */
function checkOrders(lessons: Lesson[], file: string, report: Report) {
  const firstWith = new Map<number, string>();
  let repeated = false;
  for (const lesson of lessons) {
    if (lesson.order === undefined) continue;
    const earlier = firstWith.get(lesson.order);
    if (earlier === undefined) {
      firstWith.set(lesson.order, lesson.name);
      continue;
    }
    repeated = true;
    report.error(`${file}/${lesson.name}`, `\`order\` ${lesson.order} is already used by ${earlier}`, lesson.orderLine);
  }

  const allKnown = lessons.every((lesson) => lesson.order !== undefined);
  if (!repeated && allKnown) {
    const orders = lessons.map((lesson) => lesson.order as number).sort((a, b) => a - b);
    if (orders.some((order, index) => order !== index + 1)) {
      report.error(file, `\`order\` values must be unique and run from 1 to ${lessons.length} with no gaps, but they are ${orders.join(", ")}`);
    }
  }

  for (const lesson of lessons) {
    const match = LESSON_FILE.exec(lesson.name);
    if (match?.[1] !== undefined && lesson.order !== undefined && Number(match[1]) !== lesson.order) {
      report.warning(`${file}/${lesson.name}`, `the file name starts with ${match[1]} but \`order\` is ${lesson.order}`, lesson.orderLine);
    }
  }
}
