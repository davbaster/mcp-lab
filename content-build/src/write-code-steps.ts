// Writes the step data and the ZIP of every chapter that has code to the private build folder, which only the backend reads.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildChapterZip } from "./chapter-zip.ts";
import { inspectCourse } from "./course.ts";
import { sortProblems } from "./problem.ts";
import type { Problem } from "./problem.ts";
import { diffSteps } from "./step-diff.ts";
import type { StepJson } from "./step-diff.ts";

/** The content of `<chapter_id>.json`, with the keys in the order they are written. */
export type CodeStepsJson = {
  course_id: string;
  chapter_id: string;
  zip: {
    /** The file name of the ZIP next to this file. */
    file: string;
    /** The SHA-256 of the whole ZIP, in hex. */
    sha256: string;
    /** The size of the ZIP in bytes. */
    size: number;
  };
  steps: StepJson[];
};

/**
 * Checks the code steps of every chapter listed in the course at `courseDir`. If none has a problem,
 * writes, for each listed chapter that has steps, `<buildDir>/private/code/<course_id>/<chapter_id>.json`
 * and `<chapter_id>-<hash>.zip` (the ZIP of the final step), and returns an empty list. Otherwise it
 * writes nothing, leaves the build folder as it was, and returns the problems. Everything is built in
 * memory before the first file is written. Before writing, it removes `<buildDir>/private/code/<course_id>/`
 * (and only that folder), so no file of a chapter that lost its code stays. When no chapter has code,
 * nothing is created.
 *
 * It does not check the rest of the course; run `validateCourse` first.
 */
export async function writeCodeSteps(courseDir: string, buildDir: string): Promise<Problem[]> {
  if (buildDir.trim() === "") throw new Error("writeCodeSteps needs the build folder");
  const { problems, code, chapters } = inspectCourse(courseDir);
  if (code === undefined) return problems;
  if (!/^[a-z0-9-]+$/.test(code.courseId)) {
    return [{ severity: "error", file: "", message: "the course folder name must use only lowercase letters, digits, and hyphens" }];
  }
  if (code.problems.length > 0) return sortProblems(code.problems);
  // A listed chapter that was not checked at all is one whose folder has a different problem.
  if (chapters === undefined || code.listed.length !== new Set(chapters).size) {
    const errors = problems.filter((problem) => problem.severity === "error");
    return errors.length > 0 ? errors : problems;
  }

  const outputs: { name: string; data: string | Uint8Array }[] = [];
  for (const { chapter_id, steps } of code.chapters) {
    const finalStep = steps[steps.length - 1];
    if (finalStep === undefined) continue;
    const zip = await buildChapterZip(chapter_id, finalStep.files);
    // Each object is built by listing its fields, so nothing else reaches the file.
    const json: CodeStepsJson = {
      course_id: code.courseId,
      chapter_id,
      zip: { file: zip.file, sha256: zip.sha256, size: zip.bytes.length },
      steps: diffSteps(steps).map(({ step, files }) => ({
        step,
        files: files.map(({ path, status, content, changed_lines }) => ({ path, status, content, changed_lines })),
      })),
    };
    // JSON.stringify indents with "\n", never the platform's line ending, and keeps non-ASCII text as it is.
    outputs.push({ name: `${chapter_id}.json`, data: `${JSON.stringify(json, null, 2)}\n` });
    outputs.push({ name: zip.file, data: zip.bytes });
  }

  const folder = join(resolve(buildDir), "private", "code", code.courseId);
  rmSync(folder, { recursive: true, force: true });
  if (outputs.length === 0) return [];
  mkdirSync(folder, { recursive: true });
  for (const { name, data } of outputs) writeFileSync(join(folder, name), data);
  return [];
}
