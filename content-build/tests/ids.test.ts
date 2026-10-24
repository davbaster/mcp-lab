// ids.json: what `ids:update` writes, and what `ids:check` (without --base) accepts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateCourse } from "../src/course.ts";
import { VALID_COURSE, temporaryFolder } from "./helpers.ts";
import { VALID_COURSES, coursesFolder, runIds } from "./build-support.ts";

const EXPECTED = {
  course_id: "sample-course",
  chapters: ["01-first-steps", "02-going-further"],
  lessons: ["01-welcome", "setup", "01-next"],
  questions: [
    "first-steps-1",
    "first-steps-2",
    "first-steps-3",
    "first-steps-4",
    "first-steps-5",
    "going-further-1",
    "going-further-2",
    "going-further-3",
    "going-further-4",
    "going-further-5",
  ],
};
const slashes = (path: string) => path.replaceAll("\\", "/");
const idsFile = (courses: string, id = "sample-course") => join(courses, id, "ids.json");
const FIX = "run npm run ids:update";

describe("the valid fixture", () => {
  it("holds its real IDs in the committed format and passes ids:check", () => {
    expect(readFileSync(idsFile(VALID_COURSES), "utf8")).toBe(`${JSON.stringify(EXPECTED, null, 2)}\n`);
    expect(runIds("check", [VALID_COURSES])).toMatchObject({ code: 0, stderr: "" });
  });

  it("is still a valid course", () => {
    expect(validateCourse(VALID_COURSE)).toEqual([]);
  });
});

describe("ids:update", () => {
  it("writes ids.json for every course: chapters in course.yaml order, lessons by chapter then order, questions by chapter then position", () => {
    const courses = coursesFolder({
      "sample-course": { "ids.json": "{}\n" },
      "second-course": {
        "ids.json": null,
        // The order values and the file names disagree, so the lessons must be listed by order.
        "chapters/01-first-steps/lessons/01-welcome.mdx": "---\ntitle: Welcome\norder: 2\n---\n\n# Welcome\n",
        "chapters/01-first-steps/lessons/02-setup.mdx": "---\ntitle: Setup\norder: 1\nid: setup\n---\n\n# Setup\n",
      },
    });

    const result = runIds("update", [courses]);

    expect(result).toEqual({
      code: 0,
      stdout: `${slashes(courses)}/sample-course/ids.json: written\n${slashes(courses)}/second-course/ids.json: written\n`,
      stderr: "",
    });
    expect(JSON.parse(readFileSync(idsFile(courses), "utf8"))).toEqual(EXPECTED);
    expect(JSON.parse(readFileSync(idsFile(courses, "second-course"), "utf8"))).toEqual({
      ...EXPECTED,
      course_id: "second-course",
      lessons: ["setup", "01-welcome", "01-next"],
    });
  });

  it("writes UTF-8 without a byte order mark, LF, a 2-space indent, and a final newline", () => {
    const courses = coursesFolder({ "sample-course": { "ids.json": null } });
    runIds("update", [courses]);
    const bytes = readFileSync(idsFile(courses));

    expect(bytes[0]).not.toBe(0xef);
    expect(bytes.toString("utf8")).toBe(`${JSON.stringify(EXPECTED, null, 2)}\n`);
  });

  it("changes nothing when it runs twice", () => {
    const courses = coursesFolder({ "sample-course": { "ids.json": "{}\n" } });
    runIds("update", [courses]);
    const first = readFileSync(idsFile(courses));

    const second = runIds("update", [courses]);

    expect(second.stdout).toBe(`${slashes(courses)}/sample-course/ids.json: unchanged\n`);
    expect(readFileSync(idsFile(courses)).equals(first)).toBe(true);
  });

  it("writes nothing for any course when one course has an error", () => {
    const courses = coursesFolder({ "sample-course": { "ids.json": "{}\n" }, "second-course": { "chapters/01-first-steps/quiz.yaml": null, "ids.json": null } });

    const result = runIds("update", [courses]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`${slashes(courses)}/second-course/chapters/01-first-steps/quiz.yaml: error: quiz.yaml is missing`);
    expect(readFileSync(idsFile(courses), "utf8")).toBe("{}\n");
    expect(existsSync(idsFile(courses, "second-course"))).toBe(false);
  });

  it("counts only the chapters listed in course.yaml", () => {
    const courses = coursesFolder({ "sample-course": { "ids.json": null, "chapters/03-later/code/step-1/main.py": "print(1)\n" } });

    runIds("update", [courses]);

    expect(JSON.parse(readFileSync(idsFile(courses), "utf8")).chapters).toEqual(["01-first-steps", "02-going-further"]);
  });

  it("does not change ids.json when only a chapter title changes", () => {
    const course = readFileSync(join(VALID_COURSES, "sample-course", "course.yaml"), "utf8").replace("title: First steps", "title: Getting started");
    const courses = coursesFolder({ "sample-course": { "course.yaml": course, "ids.json": null } });

    runIds("update", [courses]);

    expect(course).toContain("Getting started");
    expect(readFileSync(idsFile(courses), "utf8")).toBe(readFileSync(idsFile(VALID_COURSES), "utf8"));
    expect(runIds("check", [courses])).toEqual({ code: 0, stdout: "ids ok in 1 course(s)\n", stderr: "" });
  });

  it("uses a lesson's explicit id, and keeps the question IDs of a chapter together", () => {
    const courses = coursesFolder({ "sample-course": { "ids.json": null } });
    runIds("update", [courses]);

    const ids = JSON.parse(readFileSync(idsFile(courses), "utf8"));

    expect(ids.lessons).toContain("setup");
    expect(ids.lessons).not.toContain("02-setup");
  });

  it.each([[[]], [["a", "b"]], [[""]]])("prints the usage and exits 2 for %j", (args) => {
    const result = runIds("update", args);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage: npm run ids:update -- <courses folder>");
  });
});

describe("ids:check", () => {
  it("passes when ids.json holds the IDs of the course", () => {
    const result = runIds("check", [coursesFolder()]);

    expect(result).toEqual({ code: 0, stdout: "ids ok in 1 course(s)\n", stderr: "" });
  });

  it("fails with 'run npm run ids:update' when a course has no ids.json", () => {
    const courses = coursesFolder({ "sample-course": { "ids.json": null } });

    const result = runIds("check", [courses]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`${slashes(courses)}/sample-course/ids.json: error: ids.json is missing; ${FIX}`);
  });

  it("does not care about the line endings or a byte order mark in ids.json", () => {
    const text = `\uFEFF${JSON.stringify(EXPECTED, null, 2).replaceAll("\n", "\r\n")}\r\n`;
    const courses = coursesFolder({ "sample-course": { "ids.json": text } });

    expect(runIds("check", [courses]).code).toBe(0);
  });

  it("does not care about the order of the keys or the spacing", () => {
    const compact = JSON.stringify({ questions: EXPECTED.questions, lessons: EXPECTED.lessons, chapters: EXPECTED.chapters, course_id: "sample-course" });
    const courses = coursesFolder({ "sample-course": { "ids.json": compact } });

    expect(runIds("check", [courses]).code).toBe(0);
  });

  it.each([
    ["the placeholder {}", "{}\n", /`course_id` is missing; it lacks chapter `01-first-steps`, `02-going-further`; it lacks lesson/],
    ["JSON that is not valid", "{", /ids\.json cannot be read \(it is not valid JSON\)/],
    ["a JSON array", "[]", /ids\.json cannot be read \(it is not a JSON object\)/],
    ["a list that holds a number", '{"chapters": [1]}', /must each be a list of strings/],
    ["a hand-edited file that hides a lesson", JSON.stringify({ ...EXPECTED, lessons: ["01-welcome", "01-next"] }), /it lacks lesson `setup`/],
    ["an ID that the course does not have", JSON.stringify({ ...EXPECTED, questions: [...EXPECTED.questions, "gone-1"] }), /it has question `gone-1` that the course does not have/],
    ["IDs in a different order", JSON.stringify({ ...EXPECTED, chapters: ["02-going-further", "01-first-steps"] }), /the chapter IDs are in a different order/],
    ["another course_id", JSON.stringify({ ...EXPECTED, course_id: "other" }), /`course_id` is `other` but should be `sample-course`/],
    ["an extra key", JSON.stringify({ ...EXPECTED, extra: 1 }), /it has other keys/],
  ])("fails for %s, says run npm run ids:update, and names the course and the difference", (_name, text, message) => {
    const courses = coursesFolder({ "sample-course": { "ids.json": text } });

    const result = runIds("check", [courses]);

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(message);
    expect(result.stdout).toContain(`${slashes(courses)}/sample-course/ids.json: error: `);
    expect(result.stdout).toContain(FIX);
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe("1 error(s), 0 warning(s)");
  });

  it("fails after the content changed: a lesson was added and ids.json is stale", () => {
    const courses = coursesFolder({ "sample-course": { "chapters/02-going-further/lessons/02-more.mdx": "---\ntitle: More\norder: 2\n---\n\n# More\n" } });

    const result = runIds("check", [courses]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("it lacks lesson `02-more`");
  });

  it("prints the problems of a course with errors instead of comparing, and exits 1", () => {
    const courses = coursesFolder({ "sample-course": { "chapters/01-first-steps/quiz.yaml": null } });

    const result = runIds("check", [courses]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("quiz.yaml: error: quiz.yaml is missing");
    expect(result.stdout).not.toContain("ids.json");
  });

  it.each([
    [[]],
    [["a", "b"]],
    [["--base"]],
    [["../courses", "--base"]],
    [["../courses", "--base", " "]],
    [["--base", "main"]],
  ])("prints the usage and exits 2 for %j", (args) => {
    const result = runIds("check", args);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage: npm run ids:check -- <courses folder> [--base <git ref>]");
  });
});

describe("a courses folder without a course", () => {
  function empty() {
    const folder = join(temporaryFolder(), "courses");
    mkdirSync(folder);
    writeFileSync(join(folder, "README.md"), "# Courses\n");
    return folder;
  }

  it.each(["update", "check"] as const)("ids:%s exits 0 and says so", (command) => {
    const folder = empty();

    const result = runIds(command, [folder]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`no courses found in ${slashes(folder)}`);
    expect(result.stderr).toBe("");
  });

  it.each(["update", "check"] as const)("ids:%s exits 1 and names a courses folder that does not exist", (command) => {
    const missing = join(temporaryFolder(), "nowhere");

    const result = runIds(command, [missing]);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe(`error: the courses folder ${slashes(missing)} does not exist\n`);
  });
});
