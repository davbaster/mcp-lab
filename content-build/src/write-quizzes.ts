// Writes the compiled quizzes of a course to the private build folder, which only the backend reads.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inspectCourse } from "./course.ts";
import { sortProblems } from "./problem.ts";
import type { Problem } from "./problem.ts";

/**
 * Checks the quiz.yaml of every chapter listed in the course at `courseDir`. If none has a problem,
 * writes `<buildDir>/private/quizzes/<course_id>/<chapter_id>.json` for each chapter and returns an
 * empty list. Otherwise writes nothing and returns the problems. Before writing, it removes
 * `<buildDir>/private/quizzes/<course_id>/` (and only that folder), so no file of a removed chapter stays.
 *
 * It does not check the rest of the course; run `validateCourse` first.
 */
export function writeQuizzes(courseDir: string, buildDir: string): Problem[] {
  if (buildDir.trim() === "") throw new Error("writeQuizzes needs the build folder");
  const { problems, quizzes, chapters } = inspectCourse(courseDir);
  if (quizzes === undefined) return problems;
  if (!/^[a-z0-9-]+$/.test(quizzes.courseId)) {
    return [{ severity: "error", file: "", message: "the course folder name must use only lowercase letters, digits, and hyphens" }];
  }
  if (quizzes.problems.length > 0) return sortProblems(quizzes.problems);
  // A listed chapter that has no quiz and no quiz problem is one whose folder has a different problem.
  if (chapters === undefined || quizzes.quizzes.length !== new Set(chapters).size) {
    const errors = problems.filter((problem) => problem.severity === "error");
    return errors.length > 0 ? errors : problems;
  }

  const folder = join(resolve(buildDir), "private", "quizzes", quizzes.courseId);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  for (const quiz of quizzes.quizzes) {
    // JSON.stringify indents with "\n", never the platform's line ending, and keeps non-ASCII text as it is.
    writeFileSync(join(folder, `${quiz.chapter_id}.json`), `${JSON.stringify(quiz, null, 2)}\n`, "utf8");
  }
  return [];
}
