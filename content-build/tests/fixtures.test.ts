// One fixture per rule: each invalid course breaks one rule, and the exact list of problems is checked.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Problem } from "../src/problem.ts";
import { validateCourse } from "../src/course.ts";
import { FIXTURES, VALID_COURSE, error, warning } from "./helpers.ts";

const LESSONS = "chapters/01-intro/lessons";
const NAME_RULE = "must use only lowercase letters, digits, and hyphens";
const NOT_LISTED =
  "this chapter folder has lessons/ or quiz.yaml but is not listed in `chapters` in course.yaml, so it would be ignored; list it or remove it";
const prefixRule = (name: string, position: number) =>
  `chapter \`${name}\` is number ${position} in \`chapters\`, so its folder must be named \`0${position}-<slug>\`: two digits for the position, a hyphen, then lowercase letters, digits, and hyphens`;
const unknownKey = (key: string) => `unknown key \`${key}\``;

const invalid: Record<string, Problem[]> = {
  // course.yaml: the file itself
  "missing-course-yaml": [error("course.yaml", "course.yaml is missing")],
  "course-yaml-syntax-error": [error("course.yaml", "invalid YAML: Nested mappings are not allowed in compact mappings", 2)],
  "course-yaml-duplicate-key": [error("course.yaml", "invalid YAML: Map keys must be unique", 7)],
  // course.yaml: fields
  "missing-title": [error("course.yaml", "missing required field `title`")],
  "title-wrong-type": [error("course.yaml", "`title` must be a string", 2)],
  "description-empty": [error("course.yaml", "`description` must not be empty", 3)],
  "chapters-wrong-type": [error("course.yaml", "`chapters` must be a list", 4)],
  "chapters-item-wrong-type": [error("course.yaml", "`chapters[1]` must be a string", 6)],
  "free-preview-wrong-type": [error("course.yaml", "`free_preview` must be a list", 6)],
  "unknown-key": [error("course.yaml", unknownKey("free_previews"), 8)],
  "id-mismatch": [error("course.yaml", "`id` is `other-id` but the course folder is named `id-mismatch`; they must be equal", 1)],
  "Uppercase-Id": [error("course.yaml", `\`id\` ${NAME_RULE} (got "Uppercase-Id")`, 1)],
  "chapter-name-with-space": [error("course.yaml", `\`chapters[0]\` ${NAME_RULE} (got "01 intro")`, 5)],
  "chapter-name-uppercase": [error("course.yaml", `\`chapters[0]\` ${NAME_RULE} (got "01-Intro")`, 5)],
  "chapter-name-duplicate": [error("course.yaml", "`chapters` lists `01-intro` more than once", 6)],
  "free-preview-unlisted-chapter": [
    error("course.yaml", "`free_preview` names `02-extra`, which is not listed in `chapters`", 7),
  ],
  "chapters-empty": [error("course.yaml", "`chapters` must list at least one chapter", 4)],
  // course.yaml against the folders
  "chapters-folder-missing": [error("chapters", "the chapters/ folder is missing")],
  "chapter-folder-missing": [
    error("course.yaml", "chapter `02-more` is listed in `chapters` but chapters/02-more does not exist", 6),
  ],
  "chapter-folder-wrong-case": [
    error("chapters/01-Tools", NOT_LISTED),
    error(
      "course.yaml",
      "chapter `01-tools` is listed in `chapters` but chapters/01-tools does not exist; the folder `01-Tools` exists, but names are case-sensitive",
      5,
    ),
  ],
  "chapter-unlisted-with-lessons": [error("chapters/02-extra", NOT_LISTED)],
  "chapter-unlisted-with-quiz": [error("chapters/02-extra", NOT_LISTED)],
  // folder layout
  "chapter-wrong-prefix": [error("course.yaml", prefixRule("02-intro", 1), 5)],
  "chapter-no-prefix": [error("course.yaml", prefixRule("intro", 1), 5)],
  "chapter-no-lessons-folder": [error(`${LESSONS}`, "the lessons/ folder is missing")],
  "chapter-lessons-without-mdx": [
    error(LESSONS, "lessons/ must contain at least one .mdx lesson file"),
    warning(`${LESSONS}/notes.txt`, "this file is ignored; lessons/ holds only .mdx lesson files"),
  ],
  "chapter-no-quiz": [error("chapters/01-intro/quiz.yaml", "quiz.yaml is missing")],
  "lesson-bad-file-name": [
    error(
      `${LESSONS}/Hello.mdx`,
      "lesson file names must be NN-slug.mdx: two digits, a hyphen, then lowercase letters, digits, and hyphens",
    ),
  ],
  // lesson front matter
  "lesson-no-front-matter": [
    error(
      `${LESSONS}/01-hello.mdx`,
      "the lesson must start with a front-matter block: a `---` line, the settings, and a closing `---` line",
      1,
    ),
  ],
  "lesson-front-matter-unclosed": [
    error(`${LESSONS}/01-hello.mdx`, "the front matter that starts here has no closing `---` line", 1),
  ],
  "lesson-front-matter-bad-yaml": [
    error(
      `${LESSONS}/01-hello.mdx`,
      "invalid YAML in the front matter: Flow sequence in block collection must be sufficiently indented and end with a ]",
      3,
    ),
  ],
  "lesson-missing-title": [error(`${LESSONS}/01-hello.mdx`, "missing required field `title`")],
  "lesson-title-empty": [error(`${LESSONS}/01-hello.mdx`, "`title` must not be empty", 2)],
  "lesson-title-wrong-type": [error(`${LESSONS}/01-hello.mdx`, "`title` must be a string", 2)],
  "lesson-missing-order": [error(`${LESSONS}/01-hello.mdx`, "missing required field `order`")],
  "lesson-order-wrong-type": [error(`${LESSONS}/01-hello.mdx`, "`order` must be an integer", 3)],
  "lesson-order-zero": [error(`${LESSONS}/01-hello.mdx`, "`order` must be 1 or more", 3)],
  "lesson-unknown-key": [error(`${LESSONS}/01-hello.mdx`, unknownKey("duration"), 4)],
  "lesson-id-bad-characters": [error(`${LESSONS}/01-hello.mdx`, `\`id\` ${NAME_RULE} (got "Not Valid")`, 4)],
  "lesson-order-duplicate": [error(`${LESSONS}/01-hello.mdx`, "`order` 1 is already used by 01-again.mdx", 3)],
  "lesson-order-gap": [
    error(LESSONS, "`order` values must be unique and run from 1 to 2 with no gaps, but they are 1, 3"),
  ],
};

const warnings: Record<string, Problem[]> = {
  "chapter-in-progress": [
    warning(
      "chapters/02-later",
      "this chapter folder has only code/, so it is a chapter in progress: it is not listed in `chapters` and is not built",
    ),
  ],
  "lesson-prefix-mismatch": [warning(`${LESSONS}/05-second.mdx`, "the file name starts with 05 but `order` is 2", 3)],
  "stray-files": [
    warning(`${LESSONS}/README.txt`, "this file is ignored; lessons/ holds only .mdx lesson files"),
    warning(`${LESSONS}/drafts`, "this folder is ignored; lessons/ holds only .mdx lesson files"),
    warning("chapters/01-intro/notes.txt", "this file is not part of the chapter format and is ignored"),
    warning("chapters/README.md", "this is not a chapter folder and is ignored; chapters/ holds only chapter folders"),
    warning("notes.txt", "this file is not part of the course format and is ignored"),
  ],
};

function folders(group: string): string[] {
  return readdirSync(join(FIXTURES, group)).sort();
}

describe("the valid fixture", () => {
  it("has no problems at all", () => {
    expect(validateCourse(VALID_COURSE)).toEqual([]);
  });
});

describe("invalid fixtures", () => {
  it.each(Object.entries(invalid))("%s", (name, expected) => {
    expect(validateCourse(join(FIXTURES, "invalid", name))).toEqual(expected);
  });

  it("has an expected list for every fixture folder and a fixture for every list", () => {
    expect(folders("invalid")).toEqual(Object.keys(invalid).sort());
  });

  it("breaks every fixture with at least one error", () => {
    for (const [name, expected] of Object.entries(invalid)) {
      expect(expected.some((p) => p.severity === "error"), name).toBe(true);
    }
  });
});

describe("fixtures that only warn", () => {
  it.each(Object.entries(warnings))("%s", (name, expected) => {
    expect(validateCourse(join(FIXTURES, "warnings", name))).toEqual(expected);
  });

  it("has an expected list for every fixture folder and a fixture for every list", () => {
    expect(folders("warnings")).toEqual(Object.keys(warnings).sort());
  });
});
