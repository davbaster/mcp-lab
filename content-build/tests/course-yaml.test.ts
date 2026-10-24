// course.yaml rules beyond the one-rule fixtures: every field, every kind of bad value, and several mistakes at once.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateCourse } from "../src/course.ts";
import { chapterList, courseYaml, error, makeCourse } from "./helpers.ts";

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
      "chapters: [{id: 01-first-steps, title: First steps}, {id: 02-going-further, title: Going further}]",
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

  it("rejects an empty chapter id and an empty course id", () => {
    const problems = check({ "course.yaml": courseYaml({ id: "", chapters: chapterList("") }) });

    expect(problems.map((p) => p.message)).toContain("`chapters[0].id` must not be empty");
    expect(problems.map((p) => p.message)).toContain("`id` must not be empty");
  });

  it("rejects a wrong type inside free_preview", () => {
    expect(check({ "course.yaml": courseYaml({ free_preview: [3] }) }).map((p) => p.message)).toEqual([
      "`free_preview[0]` must be a string",
    ]);
  });
});

describe("ids and chapter ids", () => {
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
  ])("rejects a chapter id with %s", (_what, name) => {
    const problems = check({ "course.yaml": courseYaml({ chapters: chapterList(name), free_preview: [] }) });

    expect(problems.map((p) => p.message)).toContain(`\`chapters[0].id\` ${NAME_RULE} (got ${JSON.stringify(name)})`);
  });

  it("does not look for a folder named by a bad chapter id", () => {
    const problems = check({ "course.yaml": courseYaml({ chapters: chapterList("../x"), free_preview: [] }) });

    expect(problems.some((p) => p.message.includes("does not exist"))).toBe(false);
  });

  it("names a duplicate chapter and points at the repeat", () => {
    const yaml = courseYaml({ chapters: chapterList("01-first-steps", "02-going-further", "01-first-steps") });

    expect(check({ "course.yaml": yaml })).toEqual([
      error("course.yaml", "`chapters` lists `01-first-steps` more than once", 8),
    ]);
  });

  it("accepts the keys of a chapter in either order", () => {
    const yaml = courseYaml({ chapters: [{ title: "First steps", id: "01-first-steps" }, { title: "Going further", id: "02-going-further" }] });

    expect(check({ "course.yaml": yaml })).toEqual([]);
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

const CHAPTER_2 = { id: "02-going-further", title: "Going further" };
const TITLE = "`chapters[0].title`";
const ONE_LINE = `${TITLE} must be one line of plain text, without line breaks or control characters`;

/** A course.yaml whose first chapter is `item` (YAML text on one line, or lines that continue the item) and whose second is fine. */
function withChapter(...itemLines: string[]): string {
  return [
    "id: sample-course",
    "title: Sample course",
    "description: A small course.",
    "chapters:",
    ...itemLines,
    "  - {id: 02-going-further, title: Going further}",
    "free_preview: []",
    "",
  ].join("\n");
}

describe("chapters: the shape of an item", () => {
  it.each([
    ["a bare name", "  - 01-first-steps"],
    ["a number", "  - 2"],
    ["an empty item", "  -"],
    ["a list", "  - [01-first-steps]"],
  ])("rejects %s with the message that shows the form, at the item", (_what, item) => {
    expect(check({ "course.yaml": withChapter(item) })).toEqual([
      error(
        "course.yaml",
        "`chapters[0]` must be a mapping with the keys `id` and `title`, for example `{id: 01-intro, title: Introduction}`",
        5,
      ),
    ]);
  });

  it("reports the old form for each item and nothing about folders or free_preview", () => {
    const yaml = courseYaml({ chapters: ["01-first-steps", "02-going-further"] });

    expect(check({ "course.yaml": yaml }).map((p) => [p.line, p.message])).toEqual([
      [6, "`chapters[0]` must be a mapping with the keys `id` and `title`, for example `{id: 01-intro, title: Introduction}`"],
      [7, "`chapters[1]` must be a mapping with the keys `id` and `title`, for example `{id: 01-intro, title: Introduction}`"],
    ]);
  });

  it("reports only the item that is in the old form when the forms are mixed", () => {
    const yaml = courseYaml({ chapters: [{ id: "01-first-steps", title: "First steps" }, "02-going-further"] });

    expect(check({ "course.yaml": yaml }).map((p) => [p.line, p.message.slice(0, 20)])).toEqual([[7, "`chapters[1]` must b"]]);
  });

  it("reports a missing id at the item, and skips the folder checks", () => {
    const problems = check({ "course.yaml": withChapter("  - {title: First steps}") });

    expect(problems).toEqual([error("course.yaml", "missing required field `chapters[0].id`", 5)]);
  });

  it("reports a missing title at the item", () => {
    expect(check({ "course.yaml": withChapter("  - id: 01-first-steps") })).toEqual([
      error("course.yaml", "missing required field `chapters[0].title`", 5),
    ]);
  });

  it("reports both missing keys of an empty mapping", () => {
    expect(check({ "course.yaml": withChapter("  - {}") }).map((p) => p.message)).toEqual([
      "missing required field `chapters[0].id`",
      "missing required field `chapters[0].title`",
    ]);
  });

  it("reports an unknown key at that key", () => {
    const yaml = withChapter("  - id: 01-first-steps", "    title: First steps", "    subtitle: x");

    expect(check({ "course.yaml": yaml })).toEqual([error("course.yaml", "unknown key `chapters[0].subtitle`", 7)]);
  });

  it("reports the repeat of an id once, at the repeat, even when the titles differ", () => {
    const yaml = withChapter("  - {id: 01-first-steps, title: A}", "  - {id: 01-first-steps, title: B}").replace("02-going-further", "03-x");

    expect(check({ "course.yaml": yaml }).filter((p) => p.message.includes("more than once"))).toEqual([
      error("course.yaml", "`chapters` lists `01-first-steps` more than once", 6),
    ]);
  });

  it("does not take a title for a chapter id in free_preview", () => {
    const yaml = withChapter("  - {id: 01-first-steps, title: First steps}").replace("free_preview: []", "free_preview: [First steps]");

    expect(check({ "course.yaml": yaml }).map((p) => p.message)).toContain(
      "`free_preview` names `First steps`, which is not listed in `chapters`",
    );
  });
});

describe("chapters: the title", () => {
  it.each([
    ["a number", "title: 2025"],
    ["true", "title: true"],
    ["null", "title: null"],
    ["nothing", "title:"],
    ["a list", "title: [a]"],
  ])("rejects %s as not a string, at the title line", (_what, line) => {
    expect(check({ "course.yaml": withChapter("  - id: 01-first-steps", `    ${line}`) })).toEqual([
      error("course.yaml", `${TITLE} must be a string`, 6),
    ]);
  });

  it.each(["title: \"2025\"", "title: \"true\"", "title: \"null\"", "title: 'Yes'", "title: Yes"])("accepts %s as text", (line) => {
    expect(check({ "course.yaml": withChapter("  - id: 01-first-steps", `    ${line}`) })).toEqual([]);
  });

  it.each([
    ["an empty string", '""'],
    ["spaces", '"   "'],
    ["a non-breaking space", '"\u00a0"'],
    ["white space of every kind", String.raw`"\u00a0 \t\n\u2003"`],
  ])("rejects %s as empty, at the title line", (_what, value) => {
    expect(check({ "course.yaml": withChapter("  - id: 01-first-steps", `    title: ${value}`) })).toEqual([
      error("course.yaml", `${TITLE} must not be empty`, 6),
    ]);
  });

  it("accepts exactly 100 characters and rejects 101, naming the count", () => {
    expect(check({ "course.yaml": courseYaml({ chapters: [{ id: "01-first-steps", title: "x".repeat(100) }, CHAPTER_2] }) })).toEqual([]);
    expect(check({ "course.yaml": courseYaml({ chapters: [{ id: "01-first-steps", title: "x".repeat(101) }, CHAPTER_2] }) })).toEqual([
      error("course.yaml", `${TITLE} must be at most 100 characters, but it has 101`, 6),
    ]);
  });

  it("counts characters, not UTF-16 units: 100 emoji pass and 101 fail", () => {
    const emoji = (count: number) => courseYaml({ chapters: [{ id: "01-first-steps", title: "🚀".repeat(count) }, CHAPTER_2] });

    expect(check({ "course.yaml": emoji(100) })).toEqual([]);
    expect(check({ "course.yaml": emoji(101) }).map((p) => p.message)).toEqual([
      `${TITLE} must be at most 100 characters, but it has 101`,
    ]);
  });

  it("counts the trimmed text: 100 characters with spaces around pass", () => {
    const title = `  ${"x".repeat(100)}  `;

    expect(check({ "course.yaml": courseYaml({ chapters: [{ id: "01-first-steps", title }, CHAPTER_2] }) })).toEqual([]);
  });

  it("accepts a padded title (the build trims it) and a block scalar with its trailing newline", () => {
    expect(check({ "course.yaml": withChapter('  - {id: 01-first-steps, title: "  Padded  "}') })).toEqual([]);
    expect(check({ "course.yaml": withChapter("  - id: 01-first-steps", "    title: |", "      Block title") })).toEqual([]);
    expect(check({ "course.yaml": withChapter("  - id: 01-first-steps", "    title: >", "      Folded", "      title") })).toEqual([]);
  });

  it.each([
    ["two lines in a block", ["    title: |", "      One", "      Two"], 6],
    ["a line break in a quoted title", ['    title: "One\\nTwo"'], 6],
    ["a tab inside", ['    title: "One\\tTwo"'], 6],
    ["a NUL character", ['    title: "One\\u0000Two"'], 6],
    ["a DEL character", ['    title: "One\\u007fTwo"'], 6],
    ["an escape character", ['    title: "One\\u001bTwo"'], 6],
    ["NEL alone", ['    title: "\\x85"'], 6],
    ["NEL at the end", ['    title: "Intro\\x85"'], 6],
    ["the first C1 control (U+0080)", ['    title: "One\\u0080Two"'], 6],
    ["the last C1 control (U+009F)", ['    title: "One\\u009fTwo"'], 6],
    ["a line separator (U+2028) inside", ['    title: "One\\u2028Two"'], 6],
    ["a paragraph separator (U+2029) inside", ['    title: "One\\u2029Two"'], 6],
    ["a lone high surrogate", ['    title: "One\\ud800Two"'], 6],
    ["a lone low surrogate at the end", ['    title: "One\\udc00"'], 6],
  ])("rejects %s, at the title line", (_what, lines, line) => {
    expect(check({ "course.yaml": withChapter("  - id: 01-first-steps", ...lines) })).toEqual([error("course.yaml", ONE_LINE, line)]);
  });

  it("accepts zero-width spaces and a valid surrogate pair", () => {
    expect(check({ "course.yaml": withChapter("  - id: 01-first-steps", '    title: "One\\u200bTwo\\ud83d\\ude80"') })).toEqual([]);
  });

  it("reports a title that is both too long and has a line break as two problems", () => {
    const title = `${"x".repeat(60)}\n${"y".repeat(60)}`;
    const yaml = courseYaml({ chapters: [{ id: "01-first-steps", title }, CHAPTER_2] });

    expect(check({ "course.yaml": yaml }).map((p) => p.message)).toEqual([
      `${TITLE} must be at most 100 characters, but it has 121`,
      ONE_LINE,
    ]);
  });

  it("accepts plain text that looks like Markdown or HTML, two equal titles, a title equal to its id, and one letter", () => {
    const chapters = [
      { id: "01-first-steps", title: "<b>Bold</b> and *stars* and `code`" },
      { id: "02-going-further", title: "<b>Bold</b> and *stars* and `code`" },
      { id: "03-x", title: "03-x" },
      { id: "04-y", title: "A" },
    ];

    // The extra chapters have no folders, so only those messages appear; the titles raise nothing.
    expect(check({ "course.yaml": courseYaml({ chapters, free_preview: [] }) }).map((p) => p.message)).toEqual([
      "chapter `03-x` is listed in `chapters` but chapters/03-x does not exist",
      "chapter `04-y` is listed in `chapters` but chapters/04-y does not exist",
    ]);
  });

  it("takes a title with a colon and a space when it is quoted, and reports invalid YAML when it is not", () => {
    expect(check({ "course.yaml": withChapter('  - {id: 01-first-steps, title: "Building tools: the notes CRUD"}') })).toEqual([]);

    const problems = check({ "course.yaml": withChapter("  - id: 01-first-steps", "    title: Building tools: the notes CRUD") });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ severity: "error", file: "course.yaml", line: 6 });
    expect(problems[0]?.message).toMatch(/^invalid YAML: /);
  });

  it("still checks the folders of a chapter whose title is wrong", () => {
    const yaml = withChapter("  - {id: 01-first-steps, title: 5}", "  - {id: 02-gone, title: Gone}").replace("  - {id: 02-going-further, title: Going further}\n", "");

    expect(check({ "course.yaml": yaml, "chapters/02-going-further": null })).toEqual([
      error("course.yaml", "`chapters[0].title` must be a string", 5),
      error("course.yaml", "chapter `02-gone` is listed in `chapters` but chapters/02-gone does not exist", 6),
    ]);
  });

  it("reports a wrong title and a problem inside the chapter in the same run", () => {
    const yaml = withChapter("  - {id: 01-first-steps, title: '  '}");
    const problems = check({ "course.yaml": yaml, "chapters/01-first-steps/quiz.yaml": null });

    expect(problems.map((p) => `${p.file}: ${p.message}`)).toEqual([
      "chapters/01-first-steps/quiz.yaml: quiz.yaml is missing",
      "course.yaml: `chapters[0].title` must not be empty",
    ]);
  });

  it("does not need a title for a chapter folder that is not listed", () => {
    const course = makeCourse("sample-course", { "chapters/03-later/code/step-1/main.py": "print(1)\n" });

    expect(validateCourse(course).map((p) => [p.severity, p.file])).toEqual([["warning", "chapters/03-later"]]);
  });
});
