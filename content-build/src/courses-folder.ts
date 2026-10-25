// Finding the courses in a courses folder and checking them, for the commands that work on every course: `build`, `ids:update`, and `ids:check`.

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { inspectCourse } from "./course.ts";
import type { Inspection } from "./course.ts";
import { listFolder, pathKind, resolveCoursePath } from "./folder.ts";
import { countErrors, formatProblem, formatSummary, toPosix } from "./problem.ts";
import type { Problem } from "./problem.ts";
import { compareText } from "./text.ts";

export type CoursesFolder = {
  /** The absolute path. */
  path: string;
  /** The path as it starts every message: as typed, with `/` and no trailing slash. */
  shown: string;
  /** The course IDs: the sub-folders whose name does not start with `.`, in code-unit order. */
  courses: string[];
  /** Entries that cannot be courses (a link to a folder), as messages. They fail the command. */
  errors: string[];
};

/** The courses folder at `typed`, or why it cannot be used. Files in it (such as README.md) are not courses. */
export function openCoursesFolder(typed: string): CoursesFolder | { failure: string } {
  const shown = toPosix(typed);
  const path = resolveCoursePath(typed);
  const kind = pathKind(path);
  if (kind === undefined) return { failure: `the courses folder ${shown} does not exist` };
  if (kind !== "directory") return { failure: `${shown} is not a folder` };
  const entries = listFolder(path);
  if (entries === undefined) return { failure: `the courses folder ${shown} cannot be read` };
  const courses: string[] = [];
  const errors: string[] = [];
  for (const [name, entry] of entries) {
    if (name.startsWith(".")) continue;
    if (entry === "directory") courses.push(name);
    else if (entry === "other") errors.push(`${shown}/${name} is not a plain folder (for example, a symbolic link), and the build never follows links`);
  }
  return { path, shown, courses, errors };
}

export type CheckedCourse = {
  id: string;
  /** The folder of the course, as it starts the messages about it: `<courses folder>/<id>`. */
  shown: string;
  path: string;
  inspection: Inspection;
};

/** Checks each course (`validateCourse`, with what the build needs). A bad component schema or media config throws a `SetupError`. */
export function checkCourses(folder: CoursesFolder, ids: readonly string[], options: { schemaDir?: string; mediaConfigPath?: string } = {}): CheckedCourse[] {
  return ids.map((id) => {
    const path = join(folder.path, id);
    return { id, shown: `${folder.shown}/${id}`, path, inspection: inspectCourse(path, { compileLessons: true, ...options }) };
  });
}

/**
 * The problems of every course, course by course. `extra` are more problems of a course (by id), such as those of its diagrams.
 * A course that has some is listed in lesson order and then line order (the file, then the line, then the column, then the
 * message), so a problem found before drawing in a later lesson does not come before a problem found by drawing in an earlier one.
 * A course with none keeps the order of `validate`: the file, then the message.
 */
export function allProblems(
  checked: readonly CheckedCourse[],
  extra: ReadonlyMap<string, readonly Problem[]> = new Map(),
): { course: CheckedCourse; problem: Problem }[] {
  return checked.flatMap((course) => {
    const more = extra.get(course.id) ?? [];
    const problems = more.length === 0 ? course.inspection.problems : [...course.inspection.problems, ...more].sort(byPlace);
    return problems.map((problem) => ({ course, problem }));
  });
}

function byPlace(a: Problem, b: Problem): number {
  return compareText(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0) || compareText(a.message, b.message);
}

/** One line per problem, then the summary line. */
export function problemLines(found: readonly { course: CheckedCourse; problem: Problem }[]): string[] {
  return [...found.map(({ course, problem }) => formatProblem(course.shown, problem)), formatSummary(found.map(({ problem }) => problem))];
}

export function hasErrors(found: readonly { problem: Problem }[]): boolean {
  return countErrors(found.map(({ problem }) => problem)) > 0;
}

// ---- where the build may write -----------------------------------------------------------------------

/** The real path of `path`: links resolved as far as the path exists, and the rest as written. */
function realPath(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.push(current.slice(parent.length).replace(/^[\\/]+/, ""));
      current = parent;
    }
  }
}

function within(parent: string, child: string): boolean {
  const fold = (text: string) => (process.platform === "win32" || process.platform === "darwin" ? text.toLowerCase() : text);
  const path = relative(fold(parent), fold(child));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Why `build` may not write to `buildDir` when the courses are in `coursesDir`, or undefined when it may. */
export function buildFolderProblem(coursesDir: string, buildDir: string): string | undefined {
  const courses = realPath(coursesDir);
  const build = realPath(buildDir);
  if (within(courses, build)) return "the build folder must not be the courses folder or inside it";
  if (within(build, courses)) return "the build folder must not contain the courses folder, because the build removes the folders it writes to";
  return undefined;
}
