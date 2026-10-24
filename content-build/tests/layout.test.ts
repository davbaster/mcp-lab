// Folder layout rules, lesson front matter, ignored files, exact names, and CRLF/BOM handling.

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateCourse } from "../src/course.ts";
import { onDiskName } from "../src/folder.ts";
import { VALID_COURSE, error, lessonText, makeCourse, warning } from "./helpers.ts";

const FIRST = "chapters/01-first-steps";
const LESSONS = `${FIRST}/lessons`;
// The quiz of the valid course links to 02-setup.mdx by its explicit id, so a test that rewrites that file keeps the id.
const SETUP_ID = "id: setup\n";

function check(changes: Record<string, string | null>) {
  return validateCourse(makeCourse("sample-course", changes));
}

describe("lessons folder", () => {
  it("accepts lessons that are listed out of order on disk", () => {
    expect(
      check({
        [`${LESSONS}/03-third.mdx`]: lessonText("Third", 3),
        [`${LESSONS}/02-setup.mdx`]: lessonText("Setup", 2, SETUP_ID),
      }),
    ).toEqual([]);
  });

  it("rejects an .mdx file that is not named NN-slug", () => {
    const problems = check({ [`${LESSONS}/welcome.mdx`]: lessonText("Another", 3) });

    expect(problems.map((p) => [p.severity, p.file])).toEqual([["error", `${LESSONS}/welcome.mdx`]]);
  });

  it.each(["1-short.mdx", "001-long.mdx", "01_under.mdx", "01-Upper.mdx", "01-.mdx", "01-a b.mdx"])(
    "rejects the lesson file name %s",
    (name) => {
      const problems = check({ [`${LESSONS}/${name}`]: lessonText("Another", 3) });

      expect(problems.filter((p) => p.severity === "error").map((p) => p.file)).toEqual([`${LESSONS}/${name}`]);
    },
  );

  it("still reads the front matter of a badly named lesson", () => {
    const problems = check({ [`${LESSONS}/Bad.mdx`]: "no front matter\n" });

    expect(problems.filter((p) => p.file === `${LESSONS}/Bad.mdx`)).toHaveLength(2);
  });

  it("warns about a file that is not .mdx, including a different extension case", () => {
    const problems = check({ [`${LESSONS}/notes.txt`]: "x", [`${LESSONS}/03-third.MDX`]: lessonText("Third", 3) });

    expect(problems).toEqual([
      warning(`${LESSONS}/03-third.MDX`, "this file is ignored; lessons/ holds only .mdx lesson files"),
      warning(`${LESSONS}/notes.txt`, "this file is ignored; lessons/ holds only .mdx lesson files"),
    ]);
  });

  it("warns about a folder named like a lesson", () => {
    const problems = check({ [`${LESSONS}/03-third.mdx/readme.txt`]: "x" });

    expect(problems).toEqual([warning(`${LESSONS}/03-third.mdx`, "this folder is ignored; lessons/ holds only .mdx lesson files")]);
  });

  it("requires an .mdx file even when lessons/ holds other files", () => {
    const problems = check({ [`${LESSONS}/01-welcome.mdx`]: null, [`${LESSONS}/02-setup.mdx`]: null });

    expect(problems).toEqual([error(LESSONS, "lessons/ must contain at least one .mdx lesson file")]);
  });
});

describe("lesson front matter", () => {
  const lesson = (text: string) => check({ [`${LESSONS}/01-welcome.mdx`]: text });

  it("accepts an optional id", () => {
    // The quiz links to the lesson by the new id: an explicit id replaces the file name as the lesson's ID.
    const quiz = readFileSync(join(VALID_COURSE, FIRST, "quiz.yaml"), "utf8").replaceAll("lesson: 01-welcome", "lesson: welcome-lesson");

    expect(check({ [`${LESSONS}/01-welcome.mdx`]: lessonText("Welcome", 1, "id: welcome-lesson\n"), [`${FIRST}/quiz.yaml`]: quiz })).toEqual([]);
  });

  it("leaves the body to the lesson compiler (#8), which stops at the first parse error", () => {
    // #7 did not read the body at all; since #8 the body is compiled, so a body that is not valid MDX is a problem.
    expect(lesson("---\ntitle: Welcome\norder: 1\n---\n<Anything ={ not: checked } />\nimport x from 'y'\n")).toEqual([
      {
        severity: "error",
        file: `${LESSONS}/01-welcome.mdx`,
        line: 5,
        column: 11,
        message:
          "Unexpected character `=` (U+003D) after name, expected a character that can start an attribute name, such as a letter, `$`, or `_`; whitespace before attributes; or the end of the tag",
      },
    ]);
  });

  it("reports an empty front-matter block as missing title and order", () => {
    expect(lesson("---\n---\nBody\n").map((p) => p.message)).toEqual([
      "missing required field `order`",
      "missing required field `title`",
    ]);
  });

  it("rejects a front matter that is not a mapping", () => {
    expect(lesson("---\n- a\n- b\n---\n")).toEqual([
      error(`${LESSONS}/01-welcome.mdx`, "the front matter must be a mapping of keys to values", 2),
    ]);
  });

  it("rejects an order that is a decimal or a string", () => {
    expect(lesson(lessonText("Welcome", "1.5")).map((p) => p.message)).toEqual(["`order` must be an integer"]);
    expect(lesson(lessonText("Welcome", '"1"')).map((p) => p.message)).toEqual(["`order` must be an integer"]);
  });

  it("rejects a negative order", () => {
    expect(lesson(lessonText("Welcome", -1)).map((p) => p.message)).toEqual(["`order` must be 1 or more"]);
  });

  it("treats a title of only spaces as empty", () => {
    expect(lesson(lessonText('"  "', 1)).map((p) => p.message)).toEqual(["`title` must not be empty"]);
  });

  it("rejects an empty file", () => {
    expect(lesson("").map((p) => p.message)).toEqual([
      "the lesson must start with a front-matter block: a `---` line, the settings, and a closing `---` line",
    ]);
  });

  it("rejects front matter that does not start on the first line", () => {
    expect(lesson("\n---\ntitle: Welcome\norder: 1\n---\n").map((p) => p.line)).toEqual([1]);
  });

  it("reports a repeated key in the front matter at the line of the repeat", () => {
    const problems = lesson("---\ntitle: A\ntitle: B\norder: 1\n---\n");

    expect(problems).toEqual([
      error(`${LESSONS}/01-welcome.mdx`, "invalid YAML in the front matter: Map keys must be unique", 3),
    ]);
  });
});

describe("lesson order", () => {
  it("reports each duplicate on the later file, with the line of its order", () => {
    const problems = check({
      [`${LESSONS}/02-setup.mdx`]: lessonText("Setup", 1, SETUP_ID),
      [`${LESSONS}/03-extra.mdx`]: lessonText("Extra", 1),
    });

    expect(problems.filter((p) => p.severity === "error")).toEqual([
      error(`${LESSONS}/02-setup.mdx`, "`order` 1 is already used by 01-welcome.mdx", 3),
      error(`${LESSONS}/03-extra.mdx`, "`order` 1 is already used by 01-welcome.mdx", 3),
    ]);
  });

  it("reports a gap once, naming the values found", () => {
    const problems = check({ [`${LESSONS}/02-setup.mdx`]: lessonText("Setup", 4, SETUP_ID) });

    expect(problems.filter((p) => p.severity === "error")).toEqual([
      error(LESSONS, "`order` values must be unique and run from 1 to 2 with no gaps, but they are 1, 4"),
    ]);
  });

  it("requires order to start at 1", () => {
    const problems = check({
      [`${LESSONS}/01-welcome.mdx`]: lessonText("Welcome", 2),
      [`${LESSONS}/02-setup.mdx`]: lessonText("Setup", 3, SETUP_ID),
    });

    expect(problems.filter((p) => p.severity === "error").map((p) => p.message)).toEqual([
      "`order` values must be unique and run from 1 to 2 with no gaps, but they are 2, 3",
    ]);
  });

  it("does not report a gap while a lesson has a broken order", () => {
    const problems = check({ [`${LESSONS}/02-setup.mdx`]: lessonText("Setup", "oops", SETUP_ID) });

    expect(problems.map((p) => p.message)).toEqual(["`order` must be an integer"]);
  });

  it("warns, without failing, when the file name prefix differs from the order", () => {
    const swapped = check({
      [`${LESSONS}/01-welcome.mdx`]: lessonText("Welcome", 2),
      [`${LESSONS}/02-setup.mdx`]: lessonText("Setup", 1, SETUP_ID),
    });
    expect(swapped).toEqual([
      warning(`${LESSONS}/01-welcome.mdx`, "the file name starts with 01 but `order` is 2", 3),
      warning(`${LESSONS}/02-setup.mdx`, "the file name starts with 02 but `order` is 1", 3),
    ]);
  });
});

describe("chapters that are not listed", () => {
  it("warns about a folder that has only code/ and builds nothing from it", () => {
    const problems = check({ "chapters/03-later/code/step-1/main.py": "x = 1\n" });

    expect(problems.map((p) => [p.severity, p.file])).toEqual([["warning", "chapters/03-later"]]);
  });

  it("still warns about stray files inside a chapter in progress", () => {
    const problems = check({ "chapters/03-later/code/step-1/main.py": "x", "chapters/03-later/notes.txt": "x" });

    expect(problems.map((p) => [p.severity, p.file])).toEqual([
      ["warning", "chapters/03-later"],
      ["warning", "chapters/03-later/notes.txt"],
    ]);
  });

  it("errors when a chapter with code/ also has lessons/", () => {
    const problems = check({
      "chapters/03-later/code/step-1/main.py": "x",
      "chapters/03-later/lessons/01-a.mdx": lessonText("A", 1),
    });

    expect(problems.map((p) => [p.severity, p.file])).toEqual([["error", "chapters/03-later"]]);
  });

  it("only warns about an unlisted folder that has none of lessons/, quiz.yaml, or code/", () => {
    const problems = check({ "chapters/03-later/notes.txt": "x" });

    expect(problems.map((p) => [p.severity, p.file])).toEqual([["warning", "chapters/03-later"]]);
  });
});

describe("files that are not part of the format", () => {
  it("ignores .DS_Store and Thumbs.db at every level without a warning", () => {
    const changes: Record<string, string> = {};
    for (const folder of ["", "assets", "chapters", FIRST, LESSONS, `${FIRST}/code`]) {
      for (const name of [".DS_Store", "Thumbs.db"]) changes[folder === "" ? name : `${folder}/${name}`] = "x";
    }

    expect(check(changes)).toEqual([]);
  });

  it("warns, never fails, about a stray file in each folder", () => {
    const problems = check({ "extra.txt": "x", [`${FIRST}/extra.txt`]: "x", "chapters/extra.txt": "x" });

    expect(problems.map((p) => [p.severity, p.file])).toEqual([
      ["warning", `${FIRST}/extra.txt`],
      ["warning", "chapters/extra.txt"],
      ["warning", "extra.txt"],
    ]);
  });

  // #9: assets/ used to be skipped. Its files are checked now (the asset tests cover the rules).
  it("checks the files in assets/", () => {
    expect(check({ "assets/anything/at/all.bin": "x" }).map((p) => [p.severity, p.file])).toEqual([["error", "assets/anything/at/all.bin"]]);
  });

  it("warns when assets/ is a file or ids.json is a folder", () => {
    // The lesson that uses the fixture's assets is replaced, because assets/ is not a folder here.
    const course = makeCourse("sample-course", {
      assets: null,
      "ids.json": null,
      "ids.json/inside.txt": "x",
      [`chapters/02-going-further/lessons/01-next.mdx`]: lessonText("Next steps", 1),
    });
    writeFileSync(join(course, "assets"), "not a folder");

    expect(validateCourse(course)).toEqual([
      warning("assets", "`assets` should be a folder and is ignored"),
      warning("ids.json", "`ids.json` should be a file and is ignored"),
    ]);
  });

  it.each([
    ["course.yaml", error("course.yaml", "course.yaml is missing")],
    ["chapters", error("chapters", "the chapters/ folder is missing")],
    [`${LESSONS}`, error(LESSONS, "the lessons/ folder is missing")],
    [`${FIRST}/quiz.yaml`, error(`${FIRST}/quiz.yaml`, "quiz.yaml is missing")],
  ])("reports %s as missing when it has the wrong kind", (path, expected) => {
    const course = makeCourse("sample-course");
    const target = join(course, ...path.split("/"));
    const isFolder = statSync(target).isDirectory();
    rmSync(target, { recursive: true });
    if (isFolder) writeFileSync(target, "this should be a file");
    else mkdirSync(target);

    expect(validateCourse(course)).toEqual([expected]);
  });
});

describe("names are matched exactly as they appear on disk", () => {
  // Names come from a folder listing and are never opened by a name typed in another case,
  // so these hold on Windows and macOS, whose file systems ignore case.
  function renamed(from: string, to: string) {
    const course = makeCourse("sample-course");
    renameSync(join(course, ...from.split("/")), join(course, ...to.split("/")));
    return validateCourse(course);
  }

  it("does not accept a differently cased course.yaml", () => {
    expect(renamed("course.yaml", "Course.yaml")).toEqual([
      warning("Course.yaml", "this file is not part of the course format and is ignored"),
      error("course.yaml", "course.yaml is missing"),
    ]);
  });

  it("does not accept 01-First-Steps for the listed chapter 01-first-steps", () => {
    expect(renamed(FIRST, "chapters/01-First-Steps")).toEqual([
      error(
        "chapters/01-First-Steps",
        "this chapter folder has lessons/ or quiz.yaml but is not listed in `chapters` in course.yaml, so it would be ignored; list it or remove it",
      ),
      error(
        "course.yaml",
        "chapter `01-first-steps` is listed in `chapters` but chapters/01-first-steps does not exist; the folder `01-First-Steps` exists, but names are case-sensitive",
        5,
      ),
    ]);
  });

  it("does not accept Lessons/ for lessons/", () => {
    expect(renamed(LESSONS, `${FIRST}/Lessons`)).toEqual([
      warning(`${FIRST}/Lessons`, "this folder is not part of the chapter format and is ignored"),
      error(LESSONS, "the lessons/ folder is missing"),
    ]);
  });

  it("does not accept Quiz.yaml for quiz.yaml", () => {
    expect(renamed(`${FIRST}/quiz.yaml`, `${FIRST}/Quiz.yaml`)).toEqual([
      warning(`${FIRST}/Quiz.yaml`, "this file is not part of the chapter format and is ignored"),
      error(`${FIRST}/quiz.yaml`, "quiz.yaml is missing"),
    ]);
  });

  it("finds the on-disk spelling of the course folder from a path typed in another case", () => {
    const course = makeCourse("sample-course");

    expect(onDiskName(join(course, "..", "SAMPLE-COURSE"))).toBe("sample-course");
    expect(onDiskName(course)).toBe("sample-course");
  });
});

describe("CRLF line endings and a UTF-8 byte order mark", () => {
  function withEncoding(transform: (text: string) => string) {
    const course = makeCourse("sample-course");
    for (const file of filesWithExtension(course, [".yaml", ".mdx"])) {
      writeFileSync(file, transform(readFileSync(file, "utf8")));
    }
    return course;
  }

  it("accepts CRLF in every YAML and MDX file", () => {
    const course = withEncoding((text) => text.replaceAll("\n", "\r\n"));

    expect(readFileSync(join(course, "course.yaml"), "utf8")).toContain("\r\n");
    expect(validateCourse(course)).toEqual([]);
  });

  it("accepts a BOM at the start of every YAML and MDX file", () => {
    const course = withEncoding((text) => `\uFEFF${text}`);

    expect(readFileSync(join(course, "course.yaml"), "utf8").startsWith("\uFEFF")).toBe(true);
    expect(validateCourse(course)).toEqual([]);
  });

  it("accepts a BOM and CRLF together", () => {
    expect(validateCourse(withEncoding((text) => `\uFEFF${text.replaceAll("\n", "\r\n")}`))).toEqual([]);
  });

  it("still reports the right line numbers with CRLF and a BOM", () => {
    const course = makeCourse("sample-course", {
      [`${LESSONS}/01-welcome.mdx`]: `\uFEFF---\r\ntitle: Welcome\r\norder: zero\r\n---\r\n\r\nBody\r\n`,
    });

    expect(validateCourse(course)).toEqual([error(`${LESSONS}/01-welcome.mdx`, "`order` must be an integer", 3)]);
  });

  it("accepts a closing --- line that has trailing spaces and CRLF", () => {
    expect(check({ [`${LESSONS}/01-welcome.mdx`]: "---\r\ntitle: Welcome\r\norder: 1\r\n---  \r\nBody\r\n" })).toEqual([]);
  });
});

function filesWithExtension(folder: string, extensions: string[]): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return filesWithExtension(path, extensions);
    return extensions.some((extension) => entry.name.endsWith(extension)) ? [path] : [];
  });
}
