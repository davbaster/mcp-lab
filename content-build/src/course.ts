// Checks one course folder against the course format and returns every problem found.

import { join } from "node:path";
import { listFolder, onDiskName, pathKind, readText, resolveCoursePath } from "./folder.ts";
import type { Kind } from "./folder.ts";
import { sortProblems } from "./problem.ts";
import type { Problem } from "./problem.ts";
import { courseShape, checkShape } from "./schema.ts";
import { DEFAULT_SCHEMA_DIR, loadComponentSchemas } from "./component-schemas.ts";
import type { ComponentSchemas } from "./component-schemas.ts";
import { compileLesson } from "./lesson.ts";
import { parseYaml } from "./yaml-file.ts";
import type { ParsedYaml } from "./yaml-file.ts";
import { validateChapter } from "./chapter.ts";
import type { LessonChecker } from "./chapter.ts";
import { checkChapterCode, makeCodeCollector } from "./code-steps.ts";
import type { CodeCollector } from "./code-steps.ts";
import { makeQuizCollector } from "./quiz.ts";
import type { QuizCollector } from "./quiz.ts";
import type { Report } from "./report.ts";
import { checkKnownEntries, makeReport } from "./report.ts";

const COURSE_ENTRIES = {
  "course.yaml": { kind: "file", required: true },
  assets: { kind: "directory" },
  chapters: { kind: "directory", required: true },
  "ids.json": { kind: "file" },
  "MIGRATIONS.md": { kind: "file" },
} as const;

const CHAPTER_ENTRIES = {
  lessons: { kind: "directory", required: true },
  code: { kind: "directory" },
  "quiz.yaml": { kind: "file", required: true },
} as const;

/**
 * Checks the course folder at `courseDir` (either `/` or `\` may separate folders) and returns the
 * problems, sorted by file and then message. An empty list means the course is fine; warnings do not
 * make a course invalid. Only the files named in the format are read, and never a path taken from
 * a file's content.
 *
 * It also compiles every lesson of every listed chapter (see `compileLesson`) and returns the lesson's
 * problems, which have a line and a column. A component schema that is not valid is not a problem of
 * the course: it throws a `SetupError`.
 */
export function validateCourse(courseDir: string, options: { schemaDir?: string } = {}): Problem[] {
  return inspectCourse(courseDir, { compileLessons: true, ...options }).problems;
}

export type InspectOptions = {
  /** Compile the lessons too, and add their problems. `validateCourse` does; the steps that only build quizzes or code do not. */
  compileLessons?: boolean;
  /** The folder of the component schemas, for `compileLessons`. */
  schemaDir?: string;
};

export type Inspection = {
  /** What `validateCourse` returns. */
  problems: Problem[];
  /** The compiled quizzes and the problems of the quizzes. Undefined when the course folder cannot be read. */
  quizzes?: QuizCollector;
  /** The chapters listed in `course.yaml`, when it has a usable list. */
  chapters?: string[];
  /** The steps of the listed chapters that have valid code steps, and the problems of the code steps. Undefined when the course folder cannot be read. */
  code?: CodeCollector;
};

/** `validateCourse` and what else the check found out, for the steps that build from the course. */
export function inspectCourse(courseDir: string, options: InspectOptions = {}): Inspection {
  const root = resolveCoursePath(courseDir);
  const kind = pathKind(root);
  if (kind === undefined) return { problems: [{ severity: "error", file: "", message: "the course folder does not exist" }] };
  if (kind !== "directory") return { problems: [{ severity: "error", file: "", message: "the path is not a folder" }] };

  const report = makeReport();
  const found = listFolder(root);
  if (found === undefined) {
    report.error("", "the course folder cannot be read");
    return { problems: report.problems };
  }
  checkKnownEntries(report, "", found, COURSE_ENTRIES, "course");

  const folderName = onDiskName(root);
  const quizzes = makeQuizCollector(folderName);
  const code = makeCodeCollector(folderName);
  const course = readCourseYaml(root, found, folderName, report);
  const checkLesson = options.compileLessons === true ? lessonChecker(options.schemaDir ?? DEFAULT_SCHEMA_DIR) : undefined;
  if (course.chapters !== undefined) checkChapters(root, found, course.chapters, course.yaml, report, quizzes, code, checkLesson);
  return { problems: sortProblems(report.problems), quizzes, chapters: course.chapters, code };
}

/** Compiles a lesson with the component schemas, which are read once, when the first lesson needs them. */
function lessonChecker(schemaDir: string): LessonChecker {
  let components: ComponentSchemas | undefined;
  return (text, file) => {
    components ??= loadComponentSchemas(schemaDir);
    const result = compileLesson(text, { path: file, components });
    return "problems" in result ? result.problems : [];
  };
}

type CourseYaml = {
  /** The chapter names, when `chapters` is a non-empty list of strings. Otherwise nothing can be checked against the folders. */
  chapters?: string[];
  yaml?: ParsedYaml;
};

function readCourseYaml(
  root: string,
  found: Map<string, Kind>,
  folderName: string,
  report: Report,
): CourseYaml {
  const file = "course.yaml";
  if (found.get(file) !== "file") {
    report.error(file, "course.yaml is missing");
    return {};
  }
  const read = readText(join(root, file));
  if ("error" in read) {
    report.error(file, read.error);
    return {};
  }
  const yaml = parseYaml(read.text);
  if (yaml.errors.length > 0) {
    for (const { line, message } of yaml.errors) report.error(file, `invalid YAML: ${message}`, line);
    return {};
  }
  const value = yaml.value ?? {};
  if (typeof value !== "object" || Array.isArray(value)) {
    report.error(file, "course.yaml must be a mapping of keys to values");
    return {};
  }
  for (const { line, message } of checkShape(courseShape, value, yaml)) report.error(file, message, line);

  const data = value as Record<string, unknown>;
  if (typeof data.id === "string" && data.id !== "" && data.id !== folderName) {
    report.error(
      file,
      `\`id\` is \`${data.id}\` but the course folder is named \`${folderName}\`; they must be equal`,
      yaml.lineOf(["id"]),
    );
  }
  checkFreePreview(data, yaml, report);

  const chapters = data.chapters;
  const usable = Array.isArray(chapters) && chapters.length > 0 && chapters.every((c) => typeof c === "string");
  return { chapters: usable ? (chapters as string[]) : undefined, yaml };
}

function checkFreePreview(data: Record<string, unknown>, yaml: ParsedYaml, report: Report) {
  const { chapters, free_preview: preview } = data;
  if (!Array.isArray(chapters) || !Array.isArray(preview)) return;
  preview.forEach((name, index) => {
    if (typeof name === "string" && !chapters.includes(name)) {
      report.error(
        "course.yaml",
        `\`free_preview\` names \`${name}\`, which is not listed in \`chapters\``,
        yaml.lineOf(["free_preview", index]),
      );
    }
  });
}

/** Every listed chapter has a folder in the right place, and every folder is listed. */
function checkChapters(
  root: string,
  courseEntries: Map<string, Kind>,
  chapters: string[],
  yaml: ParsedYaml | undefined,
  report: Report,
  quizzes: QuizCollector,
  code: CodeCollector,
  checkLesson?: LessonChecker,
) {
  if (courseEntries.get("chapters") !== "directory") {
    report.error("chapters", "the chapters/ folder is missing");
    return;
  }
  const folders = listFolder(join(root, "chapters"));
  if (folders === undefined) {
    report.error("chapters", "the chapters/ folder cannot be read");
    return;
  }
  const NAME = /^[a-z0-9-]+$/;
  const listed = new Set(chapters);

  chapters.forEach((name, index) => {
    if (chapters.indexOf(name) !== index || !NAME.test(name)) return; // a repeat or a bad name is already reported
    const line = yaml?.lineOf(["chapters", index]);
    const prefix = String(index + 1).padStart(2, "0");
    if (!new RegExp(`^${prefix}-[a-z0-9-]+$`).test(name)) {
      report.error(
        "course.yaml",
        `chapter \`${name}\` is number ${index + 1} in \`chapters\`, so its folder must be named \`${prefix}-<slug>\`: two digits for the position, a hyphen, then lowercase letters, digits, and hyphens`,
        line,
      );
    }
    if (folders.get(name) !== "directory") {
      const sameLetters = [...folders.keys()].find((f) => f !== name && f.toLowerCase() === name.toLowerCase());
      const hint = sameLetters === undefined ? "" : `; the folder \`${sameLetters}\` exists, but names are case-sensitive`;
      report.error("course.yaml", `chapter \`${name}\` is listed in \`chapters\` but chapters/${name} does not exist${hint}`, line);
      return;
    }
    validateChapter(join(root, "chapters", name), `chapters/${name}`, CHAPTER_ENTRIES, report, {
      collector: quizzes,
      chapterId: name,
    }, checkLesson);
    checkChapterCode(join(root, "chapters", name), `chapters/${name}`, name, report, code);
  });

  for (const [name, kind] of folders) {
    if (listed.has(name)) continue;
    const file = `chapters/${name}`;
    if (kind !== "directory") {
      report.warning(file, "this is not a chapter folder and is ignored; chapters/ holds only chapter folders");
      continue;
    }
    checkUnlistedChapter(join(root, "chapters", name), file, report);
  }
}

function checkUnlistedChapter(folder: string, file: string, report: Report) {
  const found = listFolder(folder);
  if (found === undefined) {
    report.error(file, "the chapter folder cannot be read");
    return;
  }
  if (found.has("lessons") || found.has("quiz.yaml")) {
    report.error(file, "this chapter folder has lessons/ or quiz.yaml but is not listed in `chapters` in course.yaml, so it would be ignored; list it or remove it");
  } else if (found.has("code")) {
    report.warning(file, "this chapter folder has only code/, so it is a chapter in progress: it is not listed in `chapters` and is not built");
    checkKnownEntries(report, file, found, CHAPTER_ENTRIES, "chapter");
    checkChapterCode(folder, file, file.slice("chapters/".length), report);
  } else {
    report.warning(file, "this folder is not listed in `chapters` and has no lessons/, quiz.yaml, or code/, so it is ignored");
  }
}
