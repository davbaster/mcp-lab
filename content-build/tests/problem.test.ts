import { describe, expect, it } from "vitest";
import { countErrors, formatProblem, formatSummary, sortProblems, toPosix } from "../src/problem.ts";
import type { Problem } from "../src/problem.ts";

describe("formatProblem", () => {
  it("prints path, optional line, severity, and message", () => {
    const withLine: Problem = { severity: "error", file: "course.yaml", line: 4, message: "bad" };
    const withoutLine: Problem = { severity: "warning", file: "chapters/01-a", message: "odd" };

    expect(formatProblem("fixtures/x", withLine)).toBe("fixtures/x/course.yaml:4: error: bad");
    expect(formatProblem("fixtures/x", withoutLine)).toBe("fixtures/x/chapters/01-a: warning: odd");
  });

  it("uses / separators for a course path typed with backslashes or a trailing slash", () => {
    const problem: Problem = { severity: "error", file: "a/b.mdx", message: "bad" };

    expect(formatProblem("fixtures\\invalid\\x", problem)).toBe("fixtures/invalid/x/a/b.mdx: error: bad");
    expect(formatProblem("fixtures/x/", problem)).toBe("fixtures/x/a/b.mdx: error: bad");
    expect(formatProblem("C:\\courses\\x\\", problem)).toBe("C:/courses/x/a/b.mdx: error: bad");
  });

  it("prints the course path alone for a problem about the course folder", () => {
    expect(formatProblem("fixtures\\x", { severity: "error", file: "", message: "gone" })).toBe(
      "fixtures/x: error: gone",
    );
  });

  it("keeps a message with line breaks on one line", () => {
    expect(formatProblem("x", { severity: "error", file: "f", message: "one\r\ntwo\nthree" })).toBe(
      "x/f: error: one two three",
    );
  });
});

describe("formatSummary", () => {
  it("counts errors and warnings separately", () => {
    const problems: Problem[] = [
      { severity: "error", file: "a", message: "m" },
      { severity: "warning", file: "b", message: "m" },
      { severity: "warning", file: "c", message: "m" },
    ];

    expect(formatSummary(problems)).toBe("1 error(s), 2 warning(s)");
    expect(countErrors(problems)).toBe(1);
    expect(formatSummary([])).toBe("0 error(s), 0 warning(s)");
  });
});

describe("sortProblems", () => {
  it("sorts by file, then message, and does not change its input", () => {
    const input: Problem[] = [
      { severity: "error", file: "b", message: "a" },
      { severity: "warning", file: "a", message: "z" },
      { severity: "error", file: "a", message: "b" },
    ];

    expect(sortProblems(input).map((p) => `${p.file}:${p.message}`)).toEqual(["a:b", "a:z", "b:a"]);
    expect(input[0]?.file).toBe("b");
  });

  it("orders by code unit, so capitals come before lowercase on every platform", () => {
    const input: Problem[] = [
      { severity: "error", file: "course.yaml", message: "m" },
      { severity: "error", file: "Course.yaml", message: "m" },
    ];

    expect(sortProblems(input).map((p) => p.file)).toEqual(["Course.yaml", "course.yaml"]);
  });
});

describe("toPosix", () => {
  it("turns backslashes into slashes and drops trailing ones", () => {
    expect(toPosix("a\\b\\c\\")).toBe("a/b/c");
    expect(toPosix("/")).toBe("/");
    expect(toPosix("")).toBe("");
  });
});
