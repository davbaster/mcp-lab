// course.yaml rules beyond the one-rule fixtures: every field, every kind of bad value, and several mistakes at once.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateCourse } from "../src/course.ts";
import { courseYaml, error, makeCourse } from "./helpers.ts";

const NAME_RULE = "must use only lowercase letters, digits, and hyphens";

function check(changes: Record<string, string | null>, id = "sample-course") {
  return validateCourse(makeCourse(id, changes));
}

describe("a valid course.yaml", () => {
  it("accepts an empty free_preview", () => {
    expect(check({ "course.yaml": courseYaml({ free_preview: [] }) })).toEqual([]);
  });

  it("accepts a course.yaml written as ordinary block YAML with comments", () => {
    const yaml = [
      "# The sample course",
      "id: sample-course",
      "title: Sample course",
      "description: >",
      "  A small course.",
      "chapters: [01-first-steps, 02-going-further]",
      "free_preview: []",
      "",
    ].join("\n");

    expect(check({ "course.yaml": yaml })).toEqual([]);
  });
});

describe("required fields", () => {
  it.each(["id", "title", "description", "chapters", "free_preview"])("rejects a course.yaml without %s", (field) => {
    expect(check({ "course.yaml": courseYaml({ [field]: undefined }) })).toEqual([
      error("course.yaml", `missing required field \`${field}\``),
    ]);
  });

  it("names every missing field when the file is empty", () => {
    expect(check({ "course.yaml": "" }).map((p) => p.message)).toEqual([
      "missing required field `chapters`",
      "missing required field `description`",
      "missing required field `free_preview`",
      "missing required field `id`",
      "missing required field `title`",
    ]);
  });

  it("rejects a file that is not a mapping", () => {
    expect(check({ "course.yaml": "- 01-first-steps\n" })).toEqual([
      error("course.yaml", "course.yaml must be a mapping of keys to values"),
    ]);
    expect(check({ "course.yaml": "just text\n" })).toEqual([
      error("course.yaml", "course.yaml must be a mapping of keys to values"),
    ]);
  });

  it("reports a typo as an unknown key and as the missing field", () => {
    const yaml = courseYaml({ free_preview: undefined, free_previews: [] });

    expect(check({ "course.yaml": yaml })).toEqual([
      error("course.yaml", "missing required field `free_preview`"),
      error("course.yaml", "unknown key `free_previews`", 9),
    ]);
  });
});

describe("types and empty values", () => {
  it.each([
    ["id", 7, "`id` must be a string"],
    ["title", ["a"], "`title` must be a string"],
    ["description", null, "`description` must be a string"],
    ["chapters", "01-first-steps", "`chapters` must be a list"],
    ["free_preview", { a: 1 }, "`free_preview` must be a list"],
  ])("rejects a wrong type for %s", (field, value, message) => {
    const problems = check({ "course.yaml": courseYaml({ [field]: value }) });

    expect(problems.map((p) => [p.severity, p.file, p.message])).toContainEqual(["error", "course.yaml", message]);
  });

  it.each(["title", "description"])("rejects an empty %s", (field) => {
    expect(check({ "course.yaml": courseYaml({ [field]: "" }) }).map((p) => p.message)).toEqual([
      `\`${field}\` must not be empty`,
    ]);
  });

  it("treats a title of only spaces as empty", () => {
    expect(check({ "course.yaml": courseYaml({ title: "   " }) }).map((p) => p.message)).toEqual([
      "`title` must not be empty",
    ]);
  });

  it("rejects an empty chapter name and an empty id", () => {
    const problems = check({ "course.yaml": courseYaml({ id: "", chapters: [""] }) });

    expect(problems.map((p) => p.message)).toContain("`chapters[0]` must not be empty");
    expect(problems.map((p) => p.message)).toContain("`id` must not be empty");
  });

  it("rejects a wrong type inside free_preview", () => {
    expect(check({ "course.yaml": courseYaml({ free_preview: [3] }) }).map((p) => p.message)).toEqual([
      "`free_preview[0]` must be a string",
    ]);
  });
});

describe("ids and chapter names", () => {
  it("names both values when the id differs from the folder name", () => {
    const [problem] = check({ "course.yaml": courseYaml({ id: "another-id" }) });

    expect(problem?.message).toContain("`another-id`");
    expect(problem?.message).toContain("`sample-course`");
  });

  it("compares the id with the folder name exactly, including case", () => {
    const problems = check({ "course.yaml": courseYaml() }, "Sample-Course");

    expect(problems.map((p) => p.message)).toEqual([
      "`id` is `sample-course` but the course folder is named `Sample-Course`; they must be equal",
    ]);
  });

  it.each([
    ["a slash", "01-a/b"],
    ["a backslash", "01-a\\b"],
    ["a parent folder", "../outside"],
    ["a dot", "01.first"],
    ["a space", "01 first"],
    ["an underscore", "01_first"],
    ["capital letters", "01-First"],
    ["non-ASCII letters", "01-café"],
  ])("rejects a chapter name with %s", (_what, name) => {
    const problems = check({ "course.yaml": courseYaml({ chapters: [name], free_preview: [] }) });

    expect(problems.map((p) => p.message)).toContain(`\`chapters[0]\` ${NAME_RULE} (got ${JSON.stringify(name)})`);
  });

  it("does not look for a folder named by a bad chapter name", () => {
    const problems = check({ "course.yaml": courseYaml({ chapters: ["../x"], free_preview: [] }) });

    expect(problems.some((p) => p.message.includes("does not exist"))).toBe(false);
  });

  it("names a duplicate chapter and points at the repeat", () => {
    const yaml = courseYaml({ chapters: ["01-first-steps", "02-going-further", "01-first-steps"] });

    expect(check({ "course.yaml": yaml })).toEqual([
      error("course.yaml", "`chapters` lists `01-first-steps` more than once", 8),
    ]);
  });
});

describe("free_preview", () => {
  it("rejects a chapter that is not in chapters", () => {
    const yaml = courseYaml({ free_preview: ["01-first-steps", "03-other"] });

    expect(check({ "course.yaml": yaml })).toEqual([
      error("course.yaml", "`free_preview` names `03-other`, which is not listed in `chapters`", 11),
    ]);
  });
});

describe("YAML syntax", () => {
  it("reports the parser's line for a syntax error", () => {
    const yaml = "id: sample-course\ntitle: Sample\ndescription: [oops\nchapters: []\n";
    const problems = check({ "course.yaml": yaml });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ severity: "error", file: "course.yaml", line: 4 });
    expect(problems[0]?.message).toMatch(/^invalid YAML: /);
  });

  it("rejects a repeated key at the line of the repeat", () => {
    const yaml = courseYaml().replace('"title": "Sample course",', '"title": "A",\n "title": "B",');

    expect(check({ "course.yaml": yaml })).toEqual([error("course.yaml", "invalid YAML: Map keys must be unique", 4)]);
  });

  it("rejects a file with two YAML documents", () => {
    const problems = check({ "course.yaml": `${courseYaml()}---\nid: other\n` });

    expect(problems.map((p) => p.severity)).toEqual(["error"]);
    expect(problems[0]?.message).toContain("multiple documents");
  });

  it("rejects a course.yaml that is not UTF-8", () => {
    const course = makeCourse("sample-course");
    writeFileSync(join(course, "course.yaml"), Buffer.from([0x69, 0x64, 0x3a, 0x20, 0xff, 0xfe, 0x0a]));

    expect(validateCourse(course)).toEqual([error("course.yaml", "the file is not valid UTF-8")]);
  });
});

describe("several mistakes in one run", () => {
  it("reports all of them, in file then message order", () => {
    const yaml = courseYaml({ title: 5, description: "", extra: true, id: "other" });
    const problems = check({
      "course.yaml": yaml,
      "chapters/01-first-steps/quiz.yaml": null,
      "chapters/02-going-further/lessons": null,
    });

    expect(problems.map((p) => `${p.file}: ${p.message}`)).toEqual([
      "chapters/01-first-steps/quiz.yaml: quiz.yaml is missing",
      "chapters/02-going-further/lessons: the lessons/ folder is missing",
      "course.yaml: `description` must not be empty",
      "course.yaml: `id` is `other` but the course folder is named `sample-course`; they must be equal",
      "course.yaml: `title` must be a string",
      "course.yaml: unknown key `extra`",
    ]);
  });
});
