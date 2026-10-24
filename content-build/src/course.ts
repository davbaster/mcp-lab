// Checks one course folder against the course format and returns every problem found.

import { join } from "node:path";
import { listFolder, onDiskName, pathKind, readText, resolveCoursePath } from "./folder.ts";
import type { Kind } from "./folder.ts";
import { sortProblems } from "./problem.ts";
import type { Problem } from "./problem.ts";
import { courseShape, checkShape } from "./schema.ts";
import { DEFAULT_SCHEMA_DIR, loadComponentSchemas } from "./component-schemas.ts";
import type { ComponentSchemas } from "./component-schemas.ts";
import { checkAssetFiles, makeAssetCollector } from "./asset-files.ts";
import type { AssetCollector } from "./asset-files.ts";
import { compileLesson } from "./lesson.ts";
import type { CodeStepUse } from "./lesson.ts";
import type { LessonTree } from "./lesson-tree.ts";
import { loadMediaConfig } from "./media-config.ts";
import type { MediaConfig } from "./media-config.ts";
import { checkReferences } from "./references.ts";
import { parseYaml } from "./yaml-file.ts";
import type { ParsedYaml } from "./yaml-file.ts";
import { validateChapter } from "./chapter.ts";
import type { Lesson, LessonChecker } from "./chapter.ts";
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
 * the course: it throws a `SetupError`, and so does a `media-config.json` that is not valid.
 *
 * The files in assets/ are checked too, and so are the asset and media references of the lessons.
 */
export function validateCourse(courseDir: string, options: { schemaDir?: string; mediaConfigPath?: string } = {}): Problem[] {
  return inspectCourse(courseDir, { compileLessons: true, ...options }).problems;
}

export type InspectOptions = {
  /** Compile the lessons too, and add their problems. `validateCourse` does; the steps that only build quizzes or code do not. */
  compileLessons?: boolean;
  /** The folder of the component schemas, for `compileLessons`. */
  schemaDir?: string;
  /** The media config to use instead of the committed `media-config.json`. */
  mediaConfigPath?: string;
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
  /** The files in assets/, checked, and the problems of those files. Undefined when the course folder cannot be read. */
  assets?: AssetCollector;
  /** What `course.yaml` says that the build keeps. Undefined when `course.yaml` is missing or not valid. */
  course?: CourseInfo;
  /**
   * With `compileLessons`: the lessons of the listed chapters that compiled, in `course.yaml` order and then by `order`.
   * A lesson with a problem is not here, so use it only when `problems` has no error.
   */
  lessons?: CompiledLesson[];
};

/** The fields of `course.yaml` that the build copies to the manifest. `chapterTitles` maps a chapter id to its trimmed title. */
export type CourseInfo = { title: string; description: string; freePreview: string[]; chapterTitles: Map<string, string> };

/** A lesson that compiled: where it is, what its front matter says, and its tree (before the asset references are rewritten). */
export type CompiledLesson = {
  chapter_id: string;
  id: string;
  title: string;
  order: number;
  /** The file inside the course, with `/`. */
  file: string;
  tree: LessonTree;
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
  const config = loadMediaConfig(options.mediaConfigPath);
  const assets = checkAssets(root, found, folderName, config, report);
  const course = readCourseYaml(root, found, folderName, report);
  const tracker: LessonTracker = { clean: 0, used: new Set(), trees: new Map(), codeSteps: [] };
  const checkLesson =
    options.compileLessons === true ? lessonChecker(options.schemaDir ?? DEFAULT_SCHEMA_DIR, assets, config, tracker) : undefined;
  let lessons: Map<string, Lesson[]> | undefined;
  if (course.chapters !== undefined) lessons = checkChapters(root, found, course.chapters, course.yaml, report, quizzes, code, checkLesson);
  if (checkLesson !== undefined) checkCodeStepUses(tracker.codeSteps, code, report);
  if (checkLesson !== undefined && course.chapters !== undefined && everyLessonCompiled(root, course.chapters, tracker)) {
    warnAboutUnusedAssets(assets, tracker.used, report);
  }
  const compiled = checkLesson !== undefined && course.chapters !== undefined && lessons !== undefined
    ? compiledLessons(course.chapters, lessons, tracker)
    : undefined;
  return { problems: sortProblems(report.problems), quizzes, chapters: course.chapters, code, assets, course: course.info, lessons: compiled };
}

/** The lessons that compiled, for the listed chapters in order, each chapter's by `order`. */
function compiledLessons(chapters: string[], lessons: Map<string, Lesson[]>, tracker: LessonTracker): CompiledLesson[] {
  const out: CompiledLesson[] = [];
  for (const chapter_id of new Set(chapters)) {
    const ordered = [...(lessons.get(chapter_id) ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const { id, title, order, file } of ordered) {
      const tree = tracker.trees.get(file);
      if (tree !== undefined && title !== undefined && order !== undefined) out.push({ chapter_id, id, title, order, file, tree });
    }
  }
  return out;
}

/** Checks the files in assets/ and adds their problems to `report`. A course with no assets/ folder has none. */
function checkAssets(root: string, found: Map<string, Kind>, courseId: string, config: MediaConfig, report: Report): AssetCollector {
  const collector = makeAssetCollector(courseId);
  const kind = found.get("assets");
  if (kind === "other") {
    collector.problems.push({ severity: "error", file: "assets", message: "this is not a plain folder (for example, a symbolic link), and the build never follows links" });
  } else if (kind === "directory") {
    checkAssetFiles(join(root, "assets"), config.assetLimits, collector);
  }
  report.problems.push(...collector.problems);
  return collector;
}

/**
 * What the lessons did: how many compiled with no problem, which asset files they use, the trees of the
 * lessons that compiled (by file), and the `CodeSteps` tags they make (by file).
 */
type LessonTracker = { clean: number; used: Set<string>; trees: Map<string, LessonTree>; codeSteps: { file: string; uses: CodeStepUse[] }[] };

/** Compiles a lesson with the component schemas, which are read once, when the first lesson needs them, and checks its references. */
function lessonChecker(schemaDir: string, assets: AssetCollector, config: MediaConfig, tracker: LessonTracker): LessonChecker {
  let components: ComponentSchemas | undefined;
  return (text, file) => {
    components ??= loadComponentSchemas(schemaDir);
    const result = compileLesson(text, { path: file, components });
    if ("problems" in result) return result.problems;
    tracker.trees.set(file, result.tree);
    tracker.codeSteps.push({ file, uses: result.codeSteps });
    const problems = checkReferences(result.references, file, assets.entries, config, tracker.used);
    if (problems.length === 0) tracker.clean += 1;
    return problems;
  };
}

/** True when every .mdx file of every listed chapter was compiled and had no problem, so the files that lessons use are all known. */
function everyLessonCompiled(root: string, chapters: string[], tracker: LessonTracker): boolean {
  let expected = 0;
  for (const name of new Set(chapters)) {
    const lessons = /^[a-z0-9-]+$/.test(name) ? listFolder(join(root, "chapters", name, "lessons")) : undefined;
    if (lessons === undefined) return false;
    for (const [file, kind] of lessons) if (kind === "file" && file.endsWith(".mdx")) expected += 1;
  }
  return expected > 0 && tracker.clean === expected;
}

function warnAboutUnusedAssets(assets: AssetCollector, used: Set<string>, report: Report) {
  for (const { path } of assets.files) {
    if (!used.has(path)) report.warning(`assets/${path}`, "no lesson uses this file; use it in a lesson or remove it");
  }
}

type CourseYaml = {
  /** The chapter ids, when `chapters` is a non-empty list in which every item has a string `id`. Otherwise nothing can be checked against the folders. */
  chapters?: string[];
  yaml?: ParsedYaml;
  info?: CourseInfo;
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
  const items = Array.isArray(data.chapters) ? data.chapters : [];
  const ids = items.map(chapterId);
  checkChapterItems(items, ids, yaml, report);
  checkFreePreview(data, ids, yaml, report);

  const usable = items.length > 0 && ids.every((id) => id !== undefined);
  return { chapters: usable ? (ids as string[]) : undefined, yaml, info: courseInfo(data, items) };
}

/** The `id` of a `chapters` item, when the item is a mapping and its `id` is a string. */
function chapterId(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
  const id = (item as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}

/** The longest chapter title, in Unicode characters (an emoji is one). */
const MAX_CHAPTER_TITLE = 100;

/** The chapter title without leading and trailing white space, which is what the build keeps. Undefined when `title` is not a string. */
function chapterTitle(item: unknown): string | undefined {
  const title = typeof item === "object" && item !== null ? (item as Record<string, unknown>).title : undefined;
  return typeof title === "string" ? title.trim() : undefined;
}

/**
 * The rules of `chapters` that the schema cannot say: an id is listed once, and a title (trimmed) is not empty,
 * is one line, and is at most 100 characters. The type of a title and the keys of an item are the schema's.
 */
function checkChapterItems(items: unknown[], ids: (string | undefined)[], yaml: ParsedYaml, report: Report) {
  items.forEach((item, index) => {
    const id = ids[index];
    if (id !== undefined && ids.indexOf(id) !== index) {
      report.error("course.yaml", `\`chapters\` lists \`${id}\` more than once`, yaml.lineOf(["chapters", index]));
    }
    const title = chapterTitle(item);
    if (title === undefined) return;
    const field = `\`chapters[${index}].title\``;
    const line = yaml.lineOf(["chapters", index, "title"]);
    if (title === "") {
      report.error("course.yaml", `${field} must not be empty`, line);
      return;
    }
    const characters = [...title];
    if (characters.some((character) => (character.codePointAt(0) ?? 0) < 0x20 || character === "\u007f")) {
      report.error("course.yaml", `${field} must be one line of plain text, without line breaks or control characters`, line);
    }
    const length = characters.length;
    if (length > MAX_CHAPTER_TITLE) {
      report.error("course.yaml", `${field} must be at most ${MAX_CHAPTER_TITLE} characters, but it has ${length}`, line);
    }
  });
}

function courseInfo(data: Record<string, unknown>, items: unknown[]): CourseInfo | undefined {
  const { title, description, free_preview: preview } = data;
  if (typeof title !== "string" || typeof description !== "string") return undefined;
  if (!Array.isArray(preview) || !preview.every((name) => typeof name === "string")) return undefined;
  const chapterTitles = new Map<string, string>();
  for (const item of items) {
    const id = chapterId(item);
    const chapter = chapterTitle(item);
    if (id !== undefined && chapter !== undefined) chapterTitles.set(id, chapter);
  }
  return { title, description, freePreview: preview as string[], chapterTitles };
}

/** `ids` are the ids of the `chapters` items. The check waits until every item has one: otherwise a listed chapter may be the item that is missing its id. */
function checkFreePreview(data: Record<string, unknown>, ids: (string | undefined)[], yaml: ParsedYaml, report: Report) {
  const { free_preview: preview } = data;
  if (!Array.isArray(data.chapters) || !Array.isArray(preview) || ids.includes(undefined)) return;
  preview.forEach((name, index) => {
    if (typeof name === "string" && !ids.includes(name)) {
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
): Map<string, Lesson[]> {
  const lessons = new Map<string, Lesson[]>();
  if (courseEntries.get("chapters") !== "directory") {
    report.error("chapters", "the chapters/ folder is missing");
    return lessons;
  }
  const folders = listFolder(join(root, "chapters"));
  if (folders === undefined) {
    report.error("chapters", "the chapters/ folder cannot be read");
    return lessons;
  }
  const NAME = /^[a-z0-9-]+$/;
  const listed = new Set(chapters);
  const lessonFiles = new Map<string, string>(); // lesson id to the first file that uses it

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
    const chapterLessons = validateChapter(join(root, "chapters", name), `chapters/${name}`, CHAPTER_ENTRIES, report, {
      collector: quizzes,
      chapterId: name,
    }, checkLesson);
    if (chapterLessons !== undefined) {
      lessons.set(name, chapterLessons);
      checkLessonIdsAreUnique(chapterLessons, lessonFiles, report);
    }
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
  return lessons;
}

/** A lesson id is used once in a course: the lesson endpoint has no chapter in its path. `seen` maps an id to the first file that uses it. */
function checkLessonIdsAreUnique(lessons: Lesson[], seen: Map<string, string>, report: Report) {
  for (const { id, file, idLine } of lessons) {
    const first = seen.get(id);
    if (first === undefined) {
      seen.set(id, file);
    } else {
      report.error(
        file,
        `the lesson id \`${id}\` is already used by ${first}; lesson ids must be unique in a course (an id is the \`id\` in the front matter, or else the file name without .mdx)`,
        idLine,
      );
    }
  }
}

/** Checks the `CodeSteps` tags of the lessons against the steps of their chapter: the step must exist, and so must the file in it. */
function checkCodeStepUses(lessons: { file: string; uses: CodeStepUse[] }[], code: CodeCollector, report: Report) {
  for (const { file, uses } of lessons) {
    if (uses.length === 0) continue;
    const chapterId = file.split("/")[1] ?? "";
    const chapter = code.chapters.find((candidate) => candidate.chapter_id === chapterId);
    const hasProblems = code.problems.some((problem) => problem.file.startsWith(`chapters/${chapterId}/code`));
    for (const { step, file: shown, line, column } of uses) {
      const fail = (message: string) => report.error(file, message, line, column);
      if (chapter === undefined) {
        fail(
          hasProblems
            ? `\`<CodeSteps>\` shows step ${step}, but the code steps of chapter \`${chapterId}\` have problems; fix them first`
            : `\`<CodeSteps>\` shows step ${step}, but chapter \`${chapterId}\` has no code/ folder; add the steps or remove the tag`,
        );
        continue;
      }
      const found = chapter.steps.find((candidate) => candidate.step === Number(step));
      if (found === undefined) {
        const last = chapter.steps[chapter.steps.length - 1]?.step ?? 0;
        fail(`\`<CodeSteps>\` shows step ${step}, but chapter \`${chapterId}\` has the steps 1 to ${last}`);
      } else if (shown !== undefined && !found.files.has(shown)) {
        fail(
          `\`<CodeSteps>\` shows the file \`${shown}\` of step ${step}, but that step of chapter \`${chapterId}\` has no such file; write the path inside the step, with \`/\` and the exact letters, as in \`src/util.py\``,
        );
      }
    }
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
