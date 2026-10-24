// One fixture per rule: each invalid course breaks one rule, and the exact list of problems is checked.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Problem } from "../src/problem.ts";
import { validateCourse } from "../src/course.ts";
import { assetInvalid, assetWarnings } from "./asset-fixtures.ts";
import { FIXTURES, VALID_COURSE, error, lessonProblem, warning } from "./helpers.ts";

const LESSONS = "chapters/01-intro/lessons";
const NAME_RULE = "must use only lowercase letters, digits, and hyphens";
const NOT_LISTED =
  "this chapter folder has lessons/ or quiz.yaml but is not listed in `chapters` in course.yaml, so it would be ignored; list it or remove it";
const prefixRule = (name: string, position: number) =>
  `chapter \`${name}\` is number ${position} in \`chapters\`, so its folder must be named \`0${position}-<slug>\`: two digits for the position, a hyphen, then lowercase letters, digits, and hyphens`;
const idRule = (id: string, first: string) =>
  `the lesson id \`${id}\` is already used by ${first}; lesson ids must be unique in a course (an id is the \`id\` in the front matter, or else the file name without .mdx)`;
const deviceRule = (id: string) =>
  `the lesson \`id\` \`${id}\` is a Windows device name, and the id becomes a file name in the build (\`${id}.json\`); choose another id`;
const fileRule = (file: string, step: number) =>
  `\`<CodeSteps>\` shows the file \`${file}\` of step ${step}, but that step of chapter \`01-intro\` has no such file; write the path inside the step, with \`/\` and the exact letters, as in \`src/util.py\``;
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
  // lesson bodies: every lesson of a listed chapter is compiled; a parse error stops only its own lesson
  "lesson-rejected": [
    lessonProblem(
      `${LESSONS}/02-expression.mdx`,
      8,
      12,
      "JavaScript expressions in curly braces are not allowed; to show a brace as text, write `\\{` or put it in a code span",
    ),
    lessonProblem(`${LESSONS}/03-broken-tag.mdx`, 8, 1, "Expected a closing tag for `<Callout>` (8:1-8:21)"),
    lessonProblem(
      `${LESSONS}/04-unknown.mdx`,
      10,
      1,
      "link: the URL scheme `javascript:` is not allowed; use http, https, mailto, or a relative URL",
    ),
    lessonProblem(
      `${LESSONS}/04-unknown.mdx`,
      8,
      1,
      "unknown component `Iframe`; the components are `Callout`, `CodeSteps`, `Diagram`, `Image`, `Model3D`, `Tabs`, `Video`",
    ),
  ],
  // lesson ids are unique in a course, and an explicit id becomes a file name in the build (#12)
  "lesson-id-duplicate": [error(`${LESSONS}/02-again.mdx`, idRule("hello", `${LESSONS}/01-hello.mdx`), 4)],
  "lesson-id-equals-file-name": [error(`${LESSONS}/02-again.mdx`, idRule("01-hello", `${LESSONS}/01-hello.mdx`), 4)],
  "lesson-id-same-file-name-in-two-chapters": [
    error("chapters/02-more/lessons/01-hello.mdx", idRule("01-hello", `${LESSONS}/01-hello.mdx`)),
  ],
  "lesson-id-windows-device-name": [
    error(`${LESSONS}/01-hello.mdx`, deviceRule("con"), 4),
    error(`${LESSONS}/02-again.mdx`, deviceRule("com1"), 4),
  ],
  // CodeSteps tags are checked against the code steps of their chapter (#12)
  "codesteps-step-missing": [
    lessonProblem(`${LESSONS}/01-hello.mdx`, 10, 1, "`<CodeSteps>` shows step 3, but chapter `01-intro` has the steps 1 to 2"),
  ],
  "codesteps-file-missing": [
    lessonProblem(`${LESSONS}/01-hello.mdx`, 22, 3, fileRule("Main.py", 1)),
    lessonProblem(`${LESSONS}/01-hello.mdx`, 14, 1, fileRule("util/missing.py", 2)),
    lessonProblem(`${LESSONS}/01-hello.mdx`, 10, 1, fileRule("util\\helper.py", 1)),
  ],
  "codesteps-no-code-folder": [
    lessonProblem(
      `${LESSONS}/01-hello.mdx`,
      8,
      1,
      "`<CodeSteps>` shows step 1, but chapter `01-intro` has no code/ folder; add the steps or remove the tag",
    ),
  ],
  "codesteps-invalid-steps": [
    error("chapters/01-intro/code", "`step-1` is missing; steps must be numbered 1, 2, 3, and so on with no gaps"),
    lessonProblem(
      `${LESSONS}/01-hello.mdx`,
      8,
      1,
      "`<CodeSteps>` shows step 1, but the code steps of chapter `01-intro` have problems; fix them first",
    ),
  ],
  // assets/ and the asset and media references of the lessons (#9)
  ...assetInvalid,
  // quiz.yaml: the rules that need a whole course (the single-file quiz fixtures are in quiz.test.ts)
  "quiz-question-id-repeated-across-chapters": [
    error(
      "chapters/02-more/quiz.yaml",
      "question `01-intro-q3`: the id is already used by the question at chapters/01-intro/quiz.yaml:25",
      25,
    ),
  ],
};

const warnings: Record<string, Problem[]> = {
  "chapter-in-progress": [
    warning(
      "chapters/02-later",
      "this chapter folder has only code/, so it is a chapter in progress: it is not listed in `chapters` and is not built",
    ),
  ],
  ...assetWarnings,
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
