// A problem found while checking a course: the unit the validator returns and the command prints.

export type Severity = "error" | "warning";

export type Problem = {
  severity: Severity;
  /** The file or folder inside the course folder, always with `/` separators. "" is the course folder itself. */
  file: string;
  /** 1-based line in `file`, when the problem has one. */
  line?: number;
  message: string;
};

/** Orders problems by file, then message (plain code-unit order, so every platform sorts the same). */
export function sortProblems(problems: readonly Problem[]): Problem[] {
  return [...problems].sort((a, b) => compare(a.file, b.file) || compare(a.message, b.message));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function countErrors(problems: readonly Problem[]): number {
  return problems.filter((p) => p.severity === "error").length;
}

/** A path with `/` separators and no trailing slash, whatever the platform or the way it was typed. */
export function toPosix(path: string): string {
  const slashed = path.replaceAll("\\", "/");
  const trimmed = slashed.replace(/\/+$/, "");
  return trimmed === "" && slashed !== "" ? "/" : trimmed;
}

/**
 * One output line: `<path>[:<line>]: error|warning: <message>`. `coursePath` is the course path as
 * the user gave it. The message is kept on one line so each problem stays on its own line.
 */
export function formatProblem(coursePath: string, problem: Problem): string {
  const base = toPosix(coursePath);
  const where = problem.file === "" ? base : base === "/" ? `/${problem.file}` : `${base}/${problem.file}`;
  const line = problem.line === undefined ? "" : `:${problem.line}`;
  return `${where}${line}: ${problem.severity}: ${oneLine(problem.message)}`;
}

/** The last output line, `N error(s), M warning(s)`. */
export function formatSummary(problems: readonly Problem[]): string {
  const errors = countErrors(problems);
  return `${errors} error(s), ${problems.length - errors} warning(s)`;
}

function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ");
}
