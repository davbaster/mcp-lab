// The `compile` command: prints the JSON tree of one lesson, or its problems. src/compile.ts runs it.

import { SetupError } from "./component-schemas.ts";
import { compileLesson } from "./lesson.ts";
import { serializeTree } from "./lesson-tree.ts";
import { formatProblem, formatSummary, toPosix } from "./problem.ts";
import type { Problem } from "./problem.ts";
import { readText, resolveCoursePath } from "./folder.ts";
import type { Output } from "./cli.ts";

const USAGE = "usage: npm run compile -- <lesson.mdx>   (for example: npm run compile -- fixtures/lessons/valid/markdown.mdx)";

/**
 * Runs the command and returns the exit code: 0 when the lesson compiles (the tree is on stdout), 1 when
 * it is rejected (the problems are on stderr and stdout stays empty), 2 for a bad command line, and 3 when
 * the build's own setup is wrong (a component schema is not valid). `options.schemaDir` is for tests.
 */
export function main(args: readonly string[], output: Output, options: { schemaDir?: string } = {}): number {
  const path = args[0];
  if (args.length !== 1 || path === undefined || path.trim() === "") {
    output.stderr(`error: give one lesson file to compile\n${USAGE}\n`);
    return 2;
  }
  const shown = toPosix(path);
  const rejected = (problems: Problem[]) => {
    // The problems carry the path already; formatProblem puts it in front of the position.
    const lines = problems.map((problem) => formatProblem(shown, { ...problem, file: "" }));
    output.stderr(`${[...lines, formatSummary(problems)].join("\n")}\n`);
    return 1;
  };

  const read = readText(resolveCoursePath(path));
  if ("error" in read) return rejected([{ severity: "error", file: shown, message: read.error }]);
  try {
    const result = compileLesson(read.text, { path, ...options });
    if ("problems" in result) return rejected(result.problems);
    output.stdout(serializeTree(result.tree));
    return 0;
  } catch (error) {
    if (!(error instanceof SetupError)) throw error;
    output.stderr(`build setup error: ${error.message}\n`);
    return 3;
  }
}
