// validateCourse and `validate` compile the lessons of every listed chapter.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { inspectCourse, validateCourse } from "../src/course.ts";
import { writeQuizzes } from "../src/write-quizzes.ts";
import { COMPONENT_FIXTURES, FIXTURES, PART_DIR, VALID_COURSE, lessonProblem, makeCourse, temporaryFolder } from "./helpers.ts";

const LESSONS = "chapters/01-first-steps/lessons";
const SECOND = "chapters/02-going-further/lessons";
const EXPRESSION =
  "JavaScript expressions in curly braces are not allowed; to show a brace as text, write `\\{` or put it in a code span";
const withBody = (body: string, order = 1) => `---\ntitle: Welcome\norder: ${order}\n---\n\n${body}\n`;

describe("validateCourse compiles the lessons", () => {
  it("finds no problem in the valid course, whose lessons compile", () => {
    expect(validateCourse(VALID_COURSE)).toEqual([]);
  });

  it("adds the problems of a bad lesson, under chapters/NN-slug/lessons/NN-slug.mdx, with a line and a column", () => {
    const course = makeCourse("sample-course", { [`${LESSONS}/01-welcome.mdx`]: withBody("Some {1 + 1} text") });

    expect(validateCourse(course)).toEqual([lessonProblem(`${LESSONS}/01-welcome.mdx`, 6, 6, EXPRESSION)]);
  });

  it("reports the lessons of every listed chapter, and every problem of every lesson", () => {
    const course = makeCourse("sample-course", {
      [`${LESSONS}/01-welcome.mdx`]: withBody('{1 + 1}\n\n<Iframe src="x" />'),
      [`${SECOND}/01-next.mdx`]: withBody("[x](javascript:alert(1))"),
    });

    expect(validateCourse(course).map((p) => `${p.file}:${p.line}:${p.column}`)).toEqual([
      `${LESSONS}/01-welcome.mdx:6:1`,
      `${LESSONS}/01-welcome.mdx:8:1`,
      `${SECOND}/01-next.mdx:6:1`,
    ]);
  });

  it("stops a lesson at its first parse error but still checks the other lessons of the course", () => {
    const course = makeCourse("sample-course", {
      [`${LESSONS}/01-welcome.mdx`]: withBody("<Callout>\n\n{1 + 1}\n"),
      [`${LESSONS}/02-setup.mdx`]: `---\ntitle: Setup\norder: 2\nid: setup\n---\n\n{2 + 2}\n`,
      [`${SECOND}/01-next.mdx`]: withBody("<script />"),
    });

    const problems = validateCourse(course);

    expect(problems.map((p) => `${p.file}:${p.line}:${p.column}`)).toEqual([
      `${LESSONS}/01-welcome.mdx:6:1`,
      `${LESSONS}/02-setup.mdx:7:1`,
      `${SECOND}/01-next.mdx:6:1`,
    ]);
    expect(problems[0]?.message).toMatch(/^Expected a closing tag for `<Callout>`/);
  });

  it("does not compile a lesson whose front matter block cannot be found, because the course check reports that", () => {
    const course = makeCourse("sample-course", { [`${LESSONS}/01-welcome.mdx`]: "{1 + 1}\n" });

    expect(validateCourse(course)).toEqual([
      {
        severity: "error",
        file: `${LESSONS}/01-welcome.mdx`,
        line: 1,
        message: "the lesson must start with a front-matter block: a `---` line, the settings, and a closing `---` line",
      },
    ]);
  });

  it("does not compile a lesson whose front matter block is not closed", () => {
    const course = makeCourse("sample-course", { [`${LESSONS}/01-welcome.mdx`]: "---\ntitle: T\n{1 + 1}\n" });

    expect(validateCourse(course).map((p) => p.message)).toEqual(["the front matter that starts here has no closing `---` line"]);
  });

  it("compiles the body even when the front matter has its own problems, and keeps both", () => {
    const course = makeCourse("sample-course", { [`${LESSONS}/01-welcome.mdx`]: "---\ntitle: Welcome\norder: 0\n---\n\n{1 + 1}\n" });

    expect(validateCourse(course)).toEqual([
      lessonProblem(`${LESSONS}/01-welcome.mdx`, 6, 1, EXPRESSION),
      { severity: "error", file: `${LESSONS}/01-welcome.mdx`, line: 3, message: "`order` must be 1 or more" },
    ]);
  });

  it("does not compile a chapter that is not listed", () => {
    const course = makeCourse("sample-course", {
      "chapters/03-in-progress/code/step-1/main.py": "print(1)\n",
      "chapters/03-in-progress/lessons/01-x.mdx": withBody("{1 + 1}"),
    });

    expect(validateCourse(course).map((p) => p.message)).toEqual([
      "this chapter folder has lessons/ or quiz.yaml but is not listed in `chapters` in course.yaml, so it would be ignored; list it or remove it",
    ]);
  });

  it("does not compile a file that is not an .mdx lesson", () => {
    const course = makeCourse("sample-course", { [`${LESSONS}/notes.txt`]: "{1 + 1}" });

    expect(validateCourse(course).map((p) => p.severity)).toEqual(["warning"]);
  });

  it("compiles with the schema folder it is given", () => {
    const course = makeCourse("sample-course", { [`${LESSONS}/01-welcome.mdx`]: withBody('<Flag flag name="x" />') });

    expect(validateCourse(course, { schemaDir: COMPONENT_FIXTURES })).toEqual([]);
    expect(validateCourse(course).map((p) => p.message)).toEqual([
      "unknown component `Flag`; the components are `Callout`, `CodeSteps`, `Diagram`, `Image`, `Model3D`, `Tabs`, `Video`",
    ]);
  });

  it("reads the schemas once for the whole course and not at all when there is no lesson to compile", () => {
    // A schema folder that is not valid is a setup error only when a lesson needs it.
    const dir = temporaryFolder();
    writeFileSync(join(dir, "Broken.schema.json"), "{");
    const empty = makeCourse("sample-course", { "chapters": null, "course.yaml": null });

    expect(() => validateCourse(VALID_COURSE, { schemaDir: dir })).toThrow(/Broken\.schema\.json: not valid JSON/);
    expect(validateCourse(empty, { schemaDir: dir }).length).toBeGreaterThan(0);
  });

  it("does not run the lesson code of a lesson in a course", () => {
    delete (globalThis as { LESSON_RAN?: unknown }).LESSON_RAN;
    const course = makeCourse("sample-course", { [`${LESSONS}/01-welcome.mdx`]: withBody("{globalThis.LESSON_RAN = true}") });

    validateCourse(course);

    expect((globalThis as { LESSON_RAN?: unknown }).LESSON_RAN).toBeUndefined();
  });

  it("sorts lesson problems with the rest by file and then message, as before", () => {
    const course = makeCourse("sample-course", {
      [`${LESSONS}/01-welcome.mdx`]: withBody("[x](javascript:1)\n\n{1 + 1}"),
      "z-notes.txt": "x",
    });
    const problems = validateCourse(course);

    expect(problems.map((p) => p.message.slice(0, 12))).toEqual(["JavaScript e", "link: the UR", "this file is"]);
  });
});

describe("the other steps do not compile lessons", () => {
  it("lets inspectCourse and writeQuizzes ignore a bad lesson, as they did before", () => {
    const course = makeCourse("sample-course", { [`${LESSONS}/01-welcome.mdx`]: withBody("{1 + 1}") });
    const out = temporaryFolder();

    expect(inspectCourse(course).problems).toEqual([]);
    expect(writeQuizzes(course, out)).toEqual([]);
    expect(inspectCourse(course, { compileLessons: true }).problems).toHaveLength(1);
  });
});

describe("the validate command", () => {
  function run(path: string, options?: { schemaDir?: string }) {
    let stdout = "";
    let stderr = "";
    const code = main([path], { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) }, options);
    return { code, stdout, stderr };
  }

  it("exits 1 and prints file:line:column for a bad lesson", () => {
    const result = run("fixtures/invalid/lesson-rejected");

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout.split("\n")).toEqual([
      `fixtures/invalid/lesson-rejected/${LESSONS.replace("01-first-steps", "01-intro")}/02-expression.mdx:8:12: error: ${EXPRESSION}`,
      "fixtures/invalid/lesson-rejected/chapters/01-intro/lessons/03-broken-tag.mdx:8:1: error: Expected a closing tag for `<Callout>` (8:1-8:21)",
      "fixtures/invalid/lesson-rejected/chapters/01-intro/lessons/04-unknown.mdx:10:1: error: link: the URL scheme `javascript:` is not allowed; use http, https, mailto, or a relative URL",
      "fixtures/invalid/lesson-rejected/chapters/01-intro/lessons/04-unknown.mdx:8:1: error: unknown component `Iframe`; the components are `Callout`, `CodeSteps`, `Diagram`, `Image`, `Model3D`, `Tabs`, `Video`",
      "4 error(s), 0 warning(s)",
      "",
    ]);
  });

  it("exits 0 for the valid fixture", () => {
    expect(run("fixtures/valid/sample-course")).toEqual({ code: 0, stdout: "0 error(s), 0 warning(s)\n", stderr: "" });
  });

  it("exits 3 with a build setup error, not 1, when a component schema is not valid", () => {
    const dir = temporaryFolder();
    writeFileSync(join(dir, "Broken.schema.json"), "[1");
    const result = run("fixtures/valid/sample-course", { schemaDir: dir });

    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^build setup error: .*Broken\.schema\.json: not valid JSON/);
  });

  it("exits 1 as a real process for the rejected fixture, printing the line and the column", () => {
    const result = spawnSync(process.execPath, [join(PART_DIR, "src", "validate.ts"), "fixtures\\invalid\\lesson-rejected"], {
      cwd: PART_DIR,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("lesson-rejected/chapters/01-intro/lessons/02-expression.mdx:8:12: error: JavaScript expressions");
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe("4 error(s), 0 warning(s)");
  });

  it("still exits 0 for the valid fixture as a real process", () => {
    const result = spawnSync(process.execPath, [join(PART_DIR, "src", "validate.ts"), "fixtures/valid/sample-course"], { cwd: PART_DIR, encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0 error(s), 0 warning(s)\n");
  });
});

describe("fixtures and attributes", () => {
  it("keeps the lesson fixtures and their golden files free of CR, so a Windows checkout cannot change them", () => {
    const files = [
      ...readdirSync(join(FIXTURES, "lessons", "valid")).map((name) => join(FIXTURES, "lessons", "valid", name)),
      ...readdirSync(join(FIXTURES, "lessons", "invalid")).map((name) => join(FIXTURES, "lessons", "invalid", name)),
    ];

    expect(files.length).toBeGreaterThan(50);
    for (const file of files) expect(readFileSync(file).includes(0x0d), file).toBe(false);
  });

  it("marks the lesson fixtures text eol=lf in .gitattributes", () => {
    const attributes = readFileSync(join(PART_DIR, "..", ".gitattributes"), "utf8").split(/\r?\n/);

    expect(attributes).toContain("content-build/fixtures/lessons/** text eol=lf");
  });
});
