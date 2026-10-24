// The `ids:update` and `ids:check` commands. src/ids-update.ts and src/ids-check.ts run them.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SetupError } from "./component-schemas.ts";
import { allProblems, checkCourses, hasErrors, openCoursesFolder, problemLines } from "./courses-folder.ts";
import type { CheckedCourse, CoursesFolder } from "./courses-folder.ts";
import { GitError, RefError, listTree, mergeBase, pathInRepository, readBlob } from "./git.ts";
import { KINDS, courseIds, describeDifference, idsOfKind, idsText, parseIds, sameIds } from "./ids.ts";
import type { CourseIds, Kind } from "./ids.ts";
import { noteKey, parseMigrations } from "./migrations.ts";
import { formatProblem } from "./problem.ts";
import type { Problem } from "./problem.ts";
import type { Output } from "./cli.ts";

const UPDATE_USAGE = "usage: npm run ids:update -- <courses folder>   (for example: npm run ids:update -- ../courses)";
const CHECK_USAGE = "usage: npm run ids:check -- <courses folder> [--base <git ref>]   (for example: npm run ids:check -- ../courses --base origin/main)";

export type IdsOptions = { schemaDir?: string; mediaConfigPath?: string };

/** The courses folder and its checked courses, or the exit code and the message when that cannot be done. */
function load(coursesArg: string, output: Output, options: IdsOptions): { folder: CoursesFolder; checked: CheckedCourse[] } | number {
  const folder = openCoursesFolder(coursesArg);
  if ("failure" in folder) {
    output.stderr(`error: ${folder.failure}\n`);
    return 1;
  }
  if (folder.errors.length > 0) {
    output.stderr(`${folder.errors.map((message) => `error: ${message}`).join("\n")}\n`);
    return 1;
  }
  try {
    return { folder, checked: checkCourses(folder, folder.courses, options) };
  } catch (error) {
    if (!(error instanceof SetupError)) throw error;
    output.stderr(`build setup error: ${error.message}\n`);
    return 3;
  }
}

/**
 * `ids:update`: writes `ids.json` in every course. Returns the exit code: 0 when it wrote (or found nothing to write),
 * 1 when a course has an error (then nothing is written), 2 for a bad command line, and 3 for a setup error.
 */
export function updateMain(args: readonly string[], output: Output, options: IdsOptions = {}): number {
  const [coursesArg] = args;
  if (args.length !== 1 || coursesArg === undefined || coursesArg.trim() === "") {
    output.stderr(`error: give the courses folder, once\n${UPDATE_USAGE}\n`);
    return 2;
  }
  const loaded = load(coursesArg, output, options);
  if (typeof loaded === "number") return loaded;
  const { folder, checked } = loaded;
  if (checked.length === 0) {
    output.stdout(`no courses found in ${folder.shown}\n`);
    return 0;
  }
  const found = allProblems(checked);
  if (hasErrors(found)) {
    output.stdout(`${problemLines(found).join("\n")}\n`);
    return 1;
  }

  const lines: string[] = [];
  for (const course of checked) {
    const ids = courseIds(course.id, course.inspection);
    if (ids === undefined) throw new Error(`internal error: ${course.shown} has no errors but no IDs`);
    const file = join(course.path, "ids.json");
    const text = idsText(ids);
    // A file that holds the same bytes is left alone, so running it twice changes nothing.
    if (readIfExists(file) === text) {
      lines.push(`${course.shown}/ids.json: unchanged`);
    } else {
      writeFileSync(file, text, "utf8");
      lines.push(`${course.shown}/ids.json: written`);
    }
  }
  output.stdout(`${lines.join("\n")}\n`);
  return 0;
}

function readIfExists(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

type Failure = { file: string; message: string };

/**
 * `ids:check`: every course has an `ids.json` that holds the IDs it has now. With `--base <ref>`, every ID that was
 * published at the merge base and is gone needs a note in MIGRATIONS.md. Returns the exit code: 0 when all is well,
 * 1 when a check fails, 2 for a bad command line, and 3 for a setup error.
 */
export function checkMain(args: readonly string[], output: Output, options: IdsOptions = {}): number {
  const parsed = parseCheckArgs(args);
  if ("usage" in parsed) {
    output.stderr(`error: ${parsed.usage}\n${CHECK_USAGE}\n`);
    return 2;
  }
  const loaded = load(parsed.courses, output, options);
  if (typeof loaded === "number") return loaded;
  const { folder, checked } = loaded;

  if (checked.length === 0) output.stdout(`no courses found in ${folder.shown}\n`);
  const found = allProblems(checked);
  if (hasErrors(found)) {
    output.stdout(`${problemLines(found).join("\n")}\n`);
    return 1;
  }

  const failures: { path: string; failure: Failure }[] = [];
  const warnings: { path: string; problem: Problem }[] = [];
  const current = new Map<string, CourseIds>();
  for (const course of checked) {
    const result = checkIdsFile(course);
    if ("failure" in result) failures.push({ path: course.shown, failure: result.failure });
    else current.set(course.id, result.ids);
  }

  if (parsed.base !== undefined) {
    let comparison: ReturnType<typeof compareWithBase>;
    try {
      comparison = compareWithBase(folder, checked, current, parsed.base);
    } catch (error) {
      if (error instanceof RefError) {
        output.stderr(`error: ${error.message}\n${CHECK_USAGE}\n`);
        return 2;
      }
      if (!(error instanceof GitError)) throw error;
      output.stderr(`error: cannot compare with ${parsed.base}: ${error.message}\n`);
      return 1;
    }
    failures.push(...comparison.failures);
    warnings.push(...comparison.warnings);
    output.stdout(`${comparison.notice}\n`);
  }

  const lines = [
    ...warnings.map(({ path, problem }) => formatProblem(path, problem)),
    ...failures.map(({ path, failure }) => `${failure.file === "" ? path : `${path}/${failure.file}`}: error: ${failure.message}`),
  ];
  if (failures.length > 0) {
    output.stdout(`${lines.join("\n")}\n${failures.length} error(s), ${warnings.length} warning(s)\n`);
    return 1;
  }
  if (lines.length > 0) output.stdout(`${lines.join("\n")}\n`);
  output.stdout(`ids ok in ${checked.length} course(s)\n`);
  return 0;
}

function parseCheckArgs(args: readonly string[]): { courses: string; base?: string } | { usage: string } {
  const rest = [...args];
  let base: string | undefined;
  const at = rest.indexOf("--base");
  if (at !== -1) {
    const value = rest[at + 1];
    if (value === undefined || value.trim() === "") return { usage: "give the git ref after --base" };
    base = value;
    rest.splice(at, 2);
  }
  const [courses, ...extra] = rest;
  if (courses === undefined || courses.trim() === "" || extra.length > 0 || courses.startsWith("--")) {
    return { usage: "give the courses folder, once, and optionally --base <git ref>" };
  }
  return base === undefined ? { courses } : { courses, base };
}

/** The first check: `ids.json` holds the IDs the course has now. */
function checkIdsFile(course: CheckedCourse): { ids: CourseIds } | { failure: Failure } {
  const expected = courseIds(course.id, course.inspection);
  if (expected === undefined) throw new Error(`internal error: ${course.shown} has no errors but no IDs`);
  const fix = "run npm run ids:update";
  const text = readIfExists(join(course.path, "ids.json"));
  if (text === undefined) return { failure: { file: "ids.json", message: `ids.json is missing; ${fix}` } };
  const parsed = parseIds(text);
  if ("error" in parsed) return { failure: { file: "ids.json", message: `ids.json cannot be read (${parsed.error}); ${fix}` } };
  if (sameIds(text, expected)) return { ids: parsed.ids };
  return { failure: { file: "ids.json", message: `ids.json does not hold the IDs of the course (${describeDifference(parsed.ids, expected)}); ${fix}` } };
}

/** The second check: what was published at the merge base and is gone needs a note. */
function compareWithBase(
  folder: CoursesFolder,
  checked: readonly CheckedCourse[],
  current: ReadonlyMap<string, CourseIds>,
  ref: string,
): { failures: { path: string; failure: Failure }[]; warnings: { path: string; problem: Problem }[]; notice: string } {
  const base = mergeBase(folder.path, ref);
  const failures: { path: string; failure: Failure }[] = [];
  const warnings: { path: string; problem: Problem }[] = [];
  if (base === "skip") {
    return { failures, warnings, notice: `the base ${ref} is only zeros (the first push of a branch), so there is nothing to compare with; skipped` };
  }
  const short = base.commit.slice(0, 12);
  const prefix = pathInRepository(folder.path);

  // The notes of the courses that exist now, so a malformed note is reported even when nothing was removed.
  const notes = new Map<string, ReturnType<typeof parseMigrations>>();
  for (const course of checked) {
    const text = readIfExists(join(course.path, "MIGRATIONS.md"));
    const parsed = parseMigrations(text ?? "", "MIGRATIONS.md");
    notes.set(course.id, parsed);
    for (const problem of parsed.warnings) warnings.push({ path: course.shown, problem });
  }

  const published = listTree(folder.path, base.commit, prefix).filter((entry) => entry.type === "tree" && !entry.name.startsWith("."));
  let compared = 0;
  for (const { name: id } of published.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const files = listTree(folder.path, base.commit, `${prefix}${id}/`);
    const file = files.find((entry) => entry.name === "ids.json");
    if (file === undefined || file.type !== "blob" || !file.regular) continue; // not a published course at the base
    const shown = `${folder.shown}/${id}`;
    const parsed = parseIds(readBlob(folder.path, file.sha));
    if ("error" in parsed) {
      failures.push({ path: shown, failure: { file: "ids.json", message: `the ids.json of the base ${short} cannot be read (${parsed.error})` } });
      continue;
    }
    const now = current.get(id);
    if (!checked.some((course) => course.id === id)) {
      failures.push({
        path: shown,
        failure: { file: "", message: `course \`${id}\` was published (it has an ids.json at the base ${short}) but its folder is gone; v1 does not remove courses, so restore it` },
      });
      continue;
    }
    if (now === undefined) continue; // its ids.json is wrong, which is reported already
    compared += 1;
    const removedNotes = notes.get(id)?.removed ?? new Set<string>();
    for (const kind of KINDS) {
      const still = new Set(idsOfKind(now, kind));
      for (const published of idsOfKind(parsed.ids, kind)) {
        if (still.has(published) || removedNotes.has(noteKey(kind, published))) continue;
        failures.push({ path: shown, failure: { file: "ids.json", message: removedMessage(id, kind, published, short, shown) } });
      }
    }
  }
  return { failures, warnings, notice: `compared ${compared} published course(s) with the base ${ref} (${short})` };
}

function removedMessage(course: string, kind: Kind, id: string, short: string, shown: string): string {
  return (
    `course \`${course}\`: the ${kind} \`${id}\` was published (it is in ids.json at the base ${short}) and is not in ids.json now; ` +
    `if you removed or renamed it on purpose, add the line \`removed ${kind} ${id}: <reason>\` to ${shown}/MIGRATIONS.md, otherwise restore it`
  );
}
