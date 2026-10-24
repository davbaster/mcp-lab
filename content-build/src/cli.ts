// The `validate` command: prints every problem and returns the exit code. src/validate.ts runs it.

import { validateCourse } from "./course.ts";
import { countErrors, formatProblem, formatSummary } from "./problem.ts";

const USAGE = "usage: npm run validate -- <course folder>   (for example: npm run validate -- fixtures/valid/sample-course)";

export type Output = { stdout(text: string): void; stderr(text: string): void };

/** Runs the command and returns the exit code: 0 when there are no errors, 1 for errors, 2 for a bad command line. */
export function main(args: readonly string[], output: Output): number {
  if (args.length !== 1 || args[0] === undefined || args[0].trim() === "") {
    output.stderr(`error: give the course folder to check, once\n${USAGE}\n`);
    return 2;
  }
  const coursePath = args[0];
  const problems = validateCourse(coursePath);
  const lines = [...problems.map((problem) => formatProblem(coursePath, problem)), formatSummary(problems)];
  output.stdout(`${lines.join("\n")}\n`);
  return countErrors(problems) > 0 ? 1 : 0;
}
