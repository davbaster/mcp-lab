// The `build` command: checks every selected course, then writes the build folder. src/build.ts runs it.

import { mkdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { SetupError } from "./component-schemas.ts";
import { allProblems, buildFolderProblem, checkCourses, hasErrors, openCoursesFolder, problemLines } from "./courses-folder.ts";
import type { CheckedCourse } from "./courses-folder.ts";
import { toPosix } from "./problem.ts";
import { writeAssets } from "./write-assets.ts";
import { writeCodeSteps } from "./write-code-steps.ts";
import { writeCourse } from "./write-course.ts";
import { writeQuizzes } from "./write-quizzes.ts";
import type { Output } from "./cli.ts";
import type { Problem } from "./problem.ts";

const USAGE = "usage: npm run build -- <courses folder> <build folder>   (for example: npm run build -- ../courses ../build)";

/** The folders of the build folder that `build` owns: it removes them before it writes, and touches nothing else. */
export const BUILD_FOLDERS = ["private", "public", "assets-map"] as const;

export type BuildOptions = {
  /** The folder of the component schemas. For tests. */
  schemaDir?: string;
  /** The media config to use. For tests. */
  mediaConfigPath?: string;
  /** The environment, for `COURSES`. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
};

/**
 * Runs the command and returns the exit code: 0 when it built (warnings are allowed), 1 when the content has
 * errors (or the courses folder, `COURSES`, or the build folder cannot be used), 2 for a bad command line, and
 * 3 when the build's own setup is wrong (a component schema or `media-config.json` is not valid).
 *
 * All or nothing: every selected course is checked first, and when any has an error nothing in the build folder
 * is created, changed, or removed.
 */
export async function main(args: readonly string[], output: Output, options: BuildOptions = {}): Promise<number> {
  const [coursesArg, buildArg] = args;
  if (args.length !== 2 || coursesArg === undefined || buildArg === undefined || coursesArg.trim() === "" || buildArg.trim() === "") {
    output.stderr(`error: give the courses folder and the build folder, once each\n${USAGE}\n`);
    return 2;
  }

  const folder = openCoursesFolder(coursesArg);
  if ("failure" in folder) {
    output.stderr(`error: ${folder.failure}\n`);
    return 1;
  }
  const buildPath = resolve(toPosix(buildArg));
  const buildShown = toPosix(buildArg);
  const unusable = buildFolderProblem(folder.path, buildPath) ?? buildPathProblem(buildPath);
  if (unusable !== undefined) {
    output.stderr(`error: ${unusable} (${buildShown})\n`);
    return 1;
  }

  const selection = selectCourses(folder.courses, folder.shown, (options.env ?? process.env).COURSES);
  const failures = [...folder.errors, ...selection.errors];
  if (failures.length > 0) {
    output.stderr(`${failures.map((message) => `error: ${message}`).join("\n")}\n`);
    return 1;
  }

  if (folder.courses.length === 0) output.stdout(`no courses found in ${folder.shown}\n`);

  let checked: CheckedCourse[];
  try {
    checked = checkCourses(folder, selection.ids, options);
  } catch (error) {
    if (!(error instanceof SetupError)) throw error;
    output.stderr(`build setup error: ${error.message}\n`);
    return 3;
  }
  const found = allProblems(checked);
  if (checked.length > 0) output.stdout(`${problemLines(found).join("\n")}\n`);
  if (hasErrors(found)) return 1;

  const failed = await write(checked, buildPath);
  if (failed !== undefined) {
    output.stderr(`error: ${failed}\n`);
    return 1;
  }
  output.stdout(`built ${checked.length} course(s) into ${buildShown}\n`);
  return 0;
}

/** A build folder that exists but is not a folder cannot be written to. */
function buildPathProblem(buildPath: string): string | undefined {
  try {
    return statSync(buildPath).isDirectory() ? undefined : "the build folder is a file, not a folder";
  } catch {
    return undefined;
  }
}

/** The courses to build: all of them, or those named in `COURSES` (comma-separated, entries trimmed). */
function selectCourses(courses: readonly string[], shown: string, value: string | undefined): { ids: string[]; errors: string[] } {
  if (value === undefined || value.trim() === "") return { ids: [...courses], errors: [] };
  const errors: string[] = [];
  const ids: string[] = [];
  for (const entry of value.split(",").map((part) => part.trim())) {
    if (entry === "") {
      errors.push("COURSES has an empty entry; write course IDs separated by single commas, as in COURSES=mcp-server,other-course");
    } else if (ids.includes(entry)) {
      errors.push(`COURSES names \`${entry}\` more than once`);
    } else if (!courses.includes(entry)) {
      errors.push(`COURSES names \`${entry}\`, but there is no course folder ${shown}/${entry}`);
    } else {
      ids.push(entry);
    }
  }
  return { ids: errors.length > 0 ? [] : [...ids].sort(), errors: [...new Set(errors)] };
}

/** Removes the old output, then writes every course. Returns why it failed, or undefined. */
async function write(checked: readonly CheckedCourse[], buildPath: string): Promise<string | undefined> {
  for (const name of BUILD_FOLDERS) rmSync(join(buildPath, name), { recursive: true, force: true });
  mkdirSync(join(buildPath, "private"), { recursive: true });
  mkdirSync(join(buildPath, "public"), { recursive: true });
  for (const { id, shown, path, inspection } of checked) {
    // The writers check the course again; the course was valid a moment ago, so a problem here means it changed while building.
    const problems: Problem[] = [...writeQuizzes(path, buildPath), ...(await writeCodeSteps(path, buildPath)), ...writeAssets(path, buildPath)];
    if (problems.length > 0 || !writeCourse(id, inspection, buildPath)) {
      return `${shown} changed while it was being built, so the build folder is incomplete; run the build again`;
    }
  }
  return undefined;
}
