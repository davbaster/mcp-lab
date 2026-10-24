// Reads and checks the code steps of a chapter: chapters/NN-slug/code/step-N/.

import { lstatSync } from "node:fs";
import { join } from "node:path";
import { listFolder, readText } from "./folder.ts";
import type { Problem } from "./problem.ts";
import type { Report } from "./report.ts";
import { compareText, normalizeText } from "./text.ts";
import { windowsPathProblems } from "./windows-paths.ts";

/** The limits on the code of a chapter, in one place like `QUIZ_LIMITS`. */
export const CODE_LIMITS = {
  maxSteps: 20,
  maxFilesPerStep: 100,
  /** Bytes, as read from disk. */
  maxFileBytes: 256 * 1024,
  /** The longest path inside a step, such as `src/util.py`, that Windows must be able to extract. */
  maxPathLength: 100,
} as const;

const STEP_NAME = /^step-([1-9][0-9]*)$/;
/** Generated or installed files: they must not be committed, whatever kind of entry they are. */
const GENERATED = new Set(["__pycache__", ".venv", "node_modules", ".pytest_cache"]);

/** One step: its number and its files, by path with `/`, as normalized text (see `normalizeText`). */
export type StepFiles = {
  step: number;
  files: Map<string, string>;
};

export type CodeChapter = {
  chapter_id: string;
  /** In number order, from `step-1` with no gaps. */
  steps: StepFiles[];
};

export type CodeCollector = {
  /** The course folder name, which is the `course_id` of the output. */
  courseId: string;
  /** The problems of the code of the listed chapters; the other problems of the course are not here. */
  problems: Problem[];
  /** The listed chapters that have a code/ folder with valid steps, in the order of `course.yaml`. */
  chapters: CodeChapter[];
  /** The listed chapters whose folder was checked, with or without code. */
  listed: string[];
};

export function makeCodeCollector(courseId: string): CodeCollector {
  return { courseId, problems: [], chapters: [], listed: [] };
}

/**
 * Checks the code/ folder of a chapter, if it has one, and adds the problems to `report`. `folder` is
 * the chapter on disk, `file` the same folder inside the course, as used in messages. With a
 * `collector` (a listed chapter), it also keeps the problems and, when the steps are valid, the steps.
 */
export function checkChapterCode(folder: string, file: string, chapterId: string, report: Report, collector?: CodeCollector) {
  collector?.listed.push(chapterId);
  const found = listFolder(folder);
  if (found?.get("code") !== "directory") return;
  const result = checkCodeFolder(join(folder, "code"), `${file}/code`, chapterId);
  report.problems.push(...result.problems);
  if (collector === undefined) return;
  collector.problems.push(...result.problems);
  if (result.steps !== undefined) collector.chapters.push({ chapter_id: chapterId, steps: result.steps });
}

type Checked = { problems: Problem[]; steps?: StepFiles[] };

function checkCodeFolder(folder: string, file: string, chapterId: string): Checked {
  const problems: Problem[] = [];
  const error = (path: string, message: string) => problems.push({ severity: "error", file: path, message });
  const entries = listFolder(folder);
  if (entries === undefined) {
    error(file, "the code/ folder cannot be read");
    return { problems };
  }

  const numbers = new Map<number, string>();
  for (const [name, kind] of entries) {
    const match = STEP_NAME.exec(name);
    if (match?.[1] === undefined) {
      error(
        `${file}/${name}`,
        "this is not a step folder; code/ holds only folders named step-1, step-2, and so on (`step-` and a whole number with no leading zero, spelled exactly like that)",
      );
      continue;
    }
    numbers.set(Number(match[1]), name);
    if (kind !== "directory") error(`${file}/${name}`, `a step must be a folder, but this is ${kind === "file" ? "a file" : "not a folder"}`);
  }

  let missing = 1;
  while (numbers.has(missing)) missing++;
  // The smallest number not used is a gap, unless the steps are 1..N; with no steps at all it is step-1.
  if (missing <= numbers.size || numbers.size === 0) {
    error(file, `\`step-${missing}\` is missing; steps must be numbered 1, 2, 3, and so on with no gaps`);
  }
  if (numbers.size > CODE_LIMITS.maxSteps) {
    error(file, `chapter \`${chapterId}\` has ${numbers.size} steps, but the most allowed is ${CODE_LIMITS.maxSteps}`);
    return { problems };
  }

  const steps: StepFiles[] = [];
  for (const [number, name] of [...numbers].sort(([a], [b]) => a - b)) {
    if (entries.get(name) !== "directory") continue;
    const files = readStep(join(folder, name), `${file}/${name}`, problems);
    if (files !== undefined) steps.push({ step: number, files });
  }
  return problems.length > 0 ? { problems } : { problems, steps };
}

/**
 * The Windows problems of the file paths of one step (paths inside the step, with `/`), each as a problem of
 * `file/<path>`. Nothing is read from disk, so a test can give it names that the local file system cannot create.
 */
export function stepPathProblems(paths: string[], file: string): Problem[] {
  return windowsPathProblems(paths, CODE_LIMITS.maxPathLength).map(({ path, message }) => ({ severity: "error", file: `${file}/${path}`, message }));
}

/** The files of one step by path, or undefined when the step has a problem (which is added to `problems`). */
function readStep(folder: string, file: string, problems: Problem[]): Map<string, string> | undefined {
  const before = problems.length;
  const error = (path: string, message: string) => problems.push({ severity: "error", file: path, message });

  const paths: string[] = [];
  collectFiles(folder, file, "", paths, error);
  if (paths.length === 0) error(file, "this step has no files");
  if (paths.length > CODE_LIMITS.maxFilesPerStep) {
    error(file, `this step has ${paths.length} files, but the most allowed is ${CODE_LIMITS.maxFilesPerStep}`);
    return undefined;
  }
  problems.push(...stepPathProblems(paths, file));

  const files = new Map<string, string>();
  for (const path of paths.sort(compareText)) {
    const text = readCodeFile(join(folder, ...path.split("/")), `${file}/${path}`, error);
    if (text !== undefined) files.set(path, text);
  }
  return problems.length === before ? files : undefined;
}

type ErrorFn = (path: string, message: string) => void;

/**
 * Lists the plain files under `folder` (paths relative to the step, with `/`) and reports every entry
 * that must not be there. It never opens a link, and it does not go into a generated folder.
 */
function collectFiles(folder: string, file: string, relative: string, paths: string[], error: ErrorFn) {
  const entries = listFolder(folder);
  if (entries === undefined) {
    error(file, "the folder cannot be read");
    return;
  }
  for (const [name, kind] of entries) {
    const path = relative === "" ? name : `${relative}/${name}`;
    const label = `${file}/${name}`;
    if (GENERATED.has(name) || (kind === "file" && name.endsWith(".pyc"))) {
      error(label, "this must not be committed: it is generated or installed, not part of the step");
    } else if (kind === "other") {
      error(label, "this is not a plain file or folder (for example, a symbolic link), and the build never follows links");
    } else if (kind === "directory") {
      collectFiles(join(folder, name), label, path, paths, error);
    } else {
      paths.push(path);
    }
  }
}

/** The normalized text of one file, or undefined after reporting why it is not text of the allowed size. */
function readCodeFile(path: string, file: string, error: ErrorFn): string | undefined {
  let size: number;
  try {
    size = lstatSync(path).size;
  } catch {
    error(file, "the file cannot be read");
    return undefined;
  }
  if (size > CODE_LIMITS.maxFileBytes) {
    error(file, `the file is ${size} bytes, but the most allowed is ${CODE_LIMITS.maxFileBytes} bytes (256 KiB)`);
    return undefined;
  }
  const read = readText(path);
  if ("error" in read) {
    error(file, read.error);
    return undefined;
  }
  if (read.text.includes("\u0000")) {
    error(file, "the file contains a NUL character, so it is not text");
    return undefined;
  }
  return normalizeText(read.text);
}
