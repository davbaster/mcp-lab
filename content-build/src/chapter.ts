// Checks one listed chapter folder: its lessons/ folder, its quiz.yaml, and the lesson front matter.

import { join } from "node:path";
import { listFolder, readText } from "./folder.ts";
import { checkKnownEntries } from "./report.ts";
import type { EntrySpec, Report } from "./report.ts";
import { checkShape, lessonFrontMatterShape } from "./schema.ts";
import { parseYaml, stripBom } from "./yaml-file.ts";
import type { ParsedYaml } from "./yaml-file.ts";

const LESSON_FILE = /^(\d{2})-[a-z0-9-]+\.mdx$/;

type Lesson = {
  /** The file name, such as `01-intro.mdx`. */
  name: string;
  /** The lesson's `order`, when it is a valid one. */
  order?: number;
  orderLine?: number;
};

/** `folder` is the chapter on disk, `file` the same folder inside the course, as used in messages. */
export function validateChapter(folder: string, file: string, spec: EntrySpec, report: Report) {
  const found = listFolder(folder);
  if (found === undefined) {
    report.error(file, "the chapter folder cannot be read");
    return;
  }
  checkKnownEntries(report, file, found, spec, "chapter");

  if (found.get("quiz.yaml") !== "file") report.error(`${file}/quiz.yaml`, "quiz.yaml is missing");
  if (found.get("lessons") !== "directory") {
    report.error(`${file}/lessons`, "the lessons/ folder is missing");
    return;
  }
  validateLessons(join(folder, "lessons"), `${file}/lessons`, report);
}

function validateLessons(folder: string, file: string, report: Report) {
  const found = listFolder(folder);
  if (found === undefined) {
    report.error(file, "the lessons/ folder cannot be read");
    return;
  }
  const lessons: Lesson[] = [];
  for (const [name, kind] of found) {
    if (kind !== "file" || !name.endsWith(".mdx")) {
      const what = kind === "directory" ? "folder" : "file";
      report.warning(`${file}/${name}`, `this ${what} is ignored; lessons/ holds only .mdx lesson files`);
      continue;
    }
    lessons.push(readLesson(join(folder, name), `${file}/${name}`, name, report));
  }
  if (lessons.length === 0) {
    report.error(file, "lessons/ must contain at least one .mdx lesson file");
    return;
  }
  checkOrders(lessons, file, report);
}

function readLesson(path: string, file: string, name: string, report: Report): Lesson {
  const lesson: Lesson = { name };
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
  return withOrder(lesson, value as Record<string, unknown>, yaml);
}

function withOrder(lesson: Lesson, data: Record<string, unknown>, yaml: ParsedYaml): Lesson {
  const order = data.order;
  if (typeof order !== "number" || !Number.isInteger(order) || order < 1) return lesson;
  return { ...lesson, order, orderLine: yaml.lineOf(["order"]) };
}

/** The text between the opening and closing `---` lines, or why there is none. */
function splitFrontMatter(text: string): { yaml: string } | { problem: string } {
  const lines = stripBom(text).split("\n").map((l) => l.replace(/\r$/, ""));
  if (lines[0]?.trimEnd() !== "---") {
    return { problem: "the lesson must start with a front-matter block: a `---` line, the settings, and a closing `---` line" };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end === -1) return { problem: "the front matter that starts here has no closing `---` line" };
  return { yaml: lines.slice(1, end).join("\n") };
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
