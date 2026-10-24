// A YAML alias without an anchor, and an alias bomb, are content errors: they are reported as problems
// (with fixed text that does not repeat the alias name), never thrown.

import { describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { compileQuiz, writeQuizzes } from "../src/index.ts";
import { validateCourse } from "../src/course.ts";
import { parseYaml } from "../src/yaml-file.ts";
import { FIRST_QUIZ, error, lessonText, makeCourse, quizFixture, temporaryFolder } from "./helpers.ts";

const UNRESOLVED = "Unresolved alias (the anchor must be set before the alias)";
const BOMB = "Excessive alias count indicates a resource exhaustion attack";
const NAME = "alias-name-4c1e";

/** Nine levels of lists, each holding the one above nine times: far too many aliases to expand. */
const BOMB_YAML = `${[
  "a0: &a0 [x, x, x, x, x, x, x, x, x]",
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `a${n}: &a${n} [${Array(9).fill(`*a${n - 1}`).join(", ")}]`),
].join("\n")}\n`;

const quiz = quizFixture("valid", "two-options-no-snippet");

describe("a quiz.yaml with an alias that has no anchor", () => {
  it.each([
    ["correct", quiz.replace("    correct: a\n", `    correct: *${NAME}\n`), 9],
    ["id", quiz.replace("  - id: first-steps-1", `  - id: *${NAME}`), 2],
  ])("is a problem for compileQuiz, with the line, for %s", (_field, text, line) => {
    const result = compileQuiz(text, { courseId: "sample-course", chapterId: "01-first-steps", lessonIds: ["01-welcome"] });

    expect(result).toEqual({ problems: [error("chapters/01-first-steps/quiz.yaml", `invalid YAML: ${UNRESOLVED}`, line)] });
  });

  it("is a problem for compileQuiz when the file is an alias bomb", () => {
    const result = compileQuiz(BOMB_YAML, { courseId: "sample-course", chapterId: "01-first-steps" });

    expect(result).toMatchObject({ problems: [{ severity: "error", message: `invalid YAML: ${BOMB}` }] });
  });

  it("is a problem for validateCourse and writeQuizzes, which write nothing", () => {
    const course = makeCourse("sample-course", { [FIRST_QUIZ]: quiz.replace("    correct: a\n", `    correct: *${NAME}\n`) });
    const expected = [error(FIRST_QUIZ, `invalid YAML: ${UNRESOLVED}`, 9)];
    const buildDir = temporaryFolder();

    expect(validateCourse(course)).toEqual(expected);
    expect(writeQuizzes(course, `${buildDir}/build`)).toEqual(expected);
  });

  it("makes the command print the problem and exit 1, without a stack trace or the alias name", () => {
    for (const text of [quiz.replace("    correct: a\n", `    correct: *${NAME}\n`), BOMB_YAML]) {
      const course = makeCourse("sample-course", { [FIRST_QUIZ]: text });
      let stdout = "";
      let stderr = "";
      const code = main([course], { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) });
      const lines = stdout.trimEnd().split("\n");

      expect(code).toBe(1);
      expect(stderr).toBe("");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(new RegExp(`${FIRST_QUIZ}(:\\d+)?: error: invalid YAML: (Unresolved alias|Excessive alias)`));
      expect(lines[1]).toBe("1 error(s), 0 warning(s)");
      expect(stdout).not.toContain(NAME);
      expect(stdout).not.toContain("at ");
    }
  });
});

describe("the same input in course.yaml and in a lesson", () => {
  it("is a problem in course.yaml", () => {
    const course = makeCourse("sample-course", { "course.yaml": `id: sample-course\ntitle: *${NAME}\n` });

    expect(validateCourse(course)).toEqual([error("course.yaml", `invalid YAML: ${UNRESOLVED}`, 2)]);
  });

  it("is a problem in course.yaml for an alias bomb", () => {
    const course = makeCourse("sample-course", { "course.yaml": BOMB_YAML });

    expect(validateCourse(course).map((problem) => problem.message)).toEqual([`invalid YAML: ${BOMB}`]);
  });

  it("is a problem in the front matter of a lesson, at the line in the lesson file", () => {
    const lessons = "chapters/01-first-steps/lessons";
    const course = makeCourse("sample-course", { [`${lessons}/01-welcome.mdx`]: lessonText(`*${NAME}`, 1) });

    expect(validateCourse(course)).toEqual([
      error(`${lessons}/01-welcome.mdx`, `invalid YAML in the front matter: ${UNRESOLVED}`, 2),
    ]);
  });
});

describe("parseYaml", () => {
  it("accepts an alias that has an anchor", () => {
    const parsed = parseYaml("a: &x 1\nb: *x\n");

    expect(parsed.errors).toEqual([]);
    expect(parsed.value).toEqual({ a: 1, b: 1 });
  });
});
