// The `validate` command: prints every problem and returns the exit code. src/validate.ts runs it.

import { SetupError } from "./component-schemas.ts";
import { validateCourse } from "./course.ts";
import { countErrors, formatProblem, formatSummary } from "./problem.ts";
import type { Problem } from "./problem.ts";

const USAGE = "usage: npm run validate -- <course folder>   (for example: npm run validate -- fixtures/valid/sample-course)";

export type Output = { stdout(text: string): void; stderr(text: string): void };

/**
 * Runs the command and returns the exit code: 0 when there are no errors, 1 for errors, 2 for a bad
 * command line, and 3 when the build's own setup is wrong (a component schema or `media-config.json` is not valid).
 * `options.schemaDir` and `options.mediaConfigPath` are for tests.
 */
export function main(args: readonly string[], output: Output, options: { schemaDir?: string; mediaConfigPath?: string } = {}): number {
  if (args.length !== 1 || args[0] === undefined || args[0].trim() === "") {
    output.stderr(`error: give the course folder to check, once\n${USAGE}\n`);
    return 2;
  }
  const coursePath = args[0];
  let problems: Problem[];
  try {
    problems = validateCourse(coursePath, options);
  } catch (error) {
    if (!(error instanceof SetupError)) throw error;
    output.stderr(`build setup error: ${error.message}\n`);
    return 3;
  }
  const lines = [...problems.map((problem) => formatProblem(coursePath, problem)), formatSummary(problems)];
  output.stdout(`${lines.join("\n")}\n`);
  return countErrors(problems) > 0 ? 1 : 0;
}
