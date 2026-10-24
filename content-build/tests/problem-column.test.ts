// A problem can have a column; the output line and the ordering of the other problems do not change.

import { describe, expect, it } from "vitest";
import { formatProblem, sortProblems } from "../src/problem.ts";
import type { Problem } from "../src/problem.ts";
import { makeReport } from "../src/report.ts";

describe("formatProblem with a column", () => {
  it("prints <path>:<line>:<column>: error: <message>", () => {
    const problem: Problem = { severity: "error", file: "chapters/01-a/lessons/01-b.mdx", line: 6, column: 15, message: "bad" };

    expect(formatProblem("courses/x", problem)).toBe("courses/x/chapters/01-a/lessons/01-b.mdx:6:15: error: bad");
  });

  it("prints a warning with a column the same way", () => {
    expect(formatProblem("x", { severity: "warning", file: "a.mdx", line: 2, column: 3, message: "odd" })).toBe("x/a.mdx:2:3: warning: odd");
  });

  it("prints a problem without a column exactly as before", () => {
    expect(formatProblem("x", { severity: "error", file: "course.yaml", line: 4, message: "bad" })).toBe("x/course.yaml:4: error: bad");
    expect(formatProblem("x", { severity: "error", file: "course.yaml", message: "bad" })).toBe("x/course.yaml: error: bad");
  });

  it("keeps the column when the path is typed with backslashes", () => {
    expect(formatProblem("fixtures\\x", { severity: "error", file: "a.mdx", line: 1, column: 1, message: "bad" })).toBe("fixtures/x/a.mdx:1:1: error: bad");
  });
});

describe("sortProblems", () => {
  it("is not changed by a column: it still orders by file and then message", () => {
    const a: Problem = { severity: "error", file: "b.mdx", line: 1, column: 1, message: "z" };
    const b: Problem = { severity: "error", file: "a.mdx", line: 9, column: 9, message: "y" };
    const c: Problem = { severity: "error", file: "a.mdx", line: 1, column: 1, message: "z" };

    expect(sortProblems([a, c, b])).toEqual([b, c, a]);
  });
});

describe("the report", () => {
  it("adds a column only together with a line", () => {
    const report = makeReport();
    report.error("a", "one");
    report.error("a", "two", 3);
    report.error("a", "three", 3, 4);
    report.warning("a", "four", 5, 6);

    expect(report.problems).toEqual([
      { severity: "error", file: "a", message: "one" },
      { severity: "error", file: "a", line: 3, message: "two" },
      { severity: "error", file: "a", line: 3, column: 4, message: "three" },
      { severity: "warning", file: "a", line: 5, column: 6, message: "four" },
    ]);
  });
});
