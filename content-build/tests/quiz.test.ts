// quiz.yaml rules: one committed fixture per rule with the exact problem list, generated cases for
// every missing field and wrong type, the course-wide question IDs, the lesson links, and the length limits.

import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { validateCourse } from "../src/course.ts";
import type { Problem } from "../src/problem.ts";
import { FIRST_QUIZ, QUIZ_FIXTURES, courseYaml, error, makeCourse, quizFixture } from "./helpers.ts";

const SECOND_QUIZ = "chapters/02-going-further/quiz.yaml";
const q = (n: number) => `question \`first-steps-${n}\``;
const err = (message: string, line?: number) => error(FIRST_QUIZ, message, line);
const ID_RULE = "must use only lowercase letters, digits, and hyphens";

function check(text: string, changes: Record<string, string | null> = {}): Problem[] {
  return validateCourse(makeCourse("sample-course", { [FIRST_QUIZ]: text, ...changes }));
}

function files(group: "valid" | "invalid"): string[] {
  return readdirSync(join(QUIZ_FIXTURES, group)).map((name) => name.replace(/\.yaml$/, "")).sort();
}

describe("valid quizzes", () => {
  it.each([
    "two-options-no-snippet",
    "three-options-with-snippet",
    "mixed",
    "non-ascii",
    "block-scalars",
  ])("accepts %s", (name) => {
    expect(check(quizFixture("valid", name))).toEqual([]);
  });

  it("has a test for every valid fixture", () => {
    expect(files("valid")).toEqual(["block-scalars", "mixed", "non-ascii", "three-options-with-snippet", "two-options-no-snippet"]);
  });

  it("accepts the quiz of the valid course", () => {
    expect(validateCourse(makeCourse("sample-course"))).toEqual([]);
  });
});

// Each fixture is the same 5-question quiz with one change. The lines are counted in the fixture: a
// question of two options takes 10 lines, so question 2 starts on line 12 and question 3 on line 22.
const invalid: Record<string, Problem[]> = {
  // the file as a whole
  "yaml-syntax-error": [err("invalid YAML: Nested mappings are not allowed in compact mappings", 13)],
  "yaml-repeated-key": [err("invalid YAML: Map keys must be unique", 20)],
  "empty-file": [err("missing required field `questions`")],
  "top-level-list": [err("quiz.yaml must be a mapping of keys to values")],
  "questions-key-missing": [err("missing required field `questions`"), err("unknown key `quiz`", 1)],
  "questions-not-a-list": [err("`questions` must be a list", 1)],
  "question-not-a-mapping": [err("question 3 must be a mapping of keys to values", 22)],
  // unknown keys
  "unknown-key-top-level": [err("unknown key `extra`", 52)],
  "unknown-key-question": [err(`${q(2)}: unknown key \`hint\``, 22)],
  "unknown-key-option": [err(`${q(2)}, option \`b\`: unknown key \`hint\``, 19)],
  "unknown-key-snippet": [err(`${q(2)}, snippet: unknown key \`theme\``, 17)],
  // rules: how many
  "questions-4": [err("the quiz must have exactly 5 questions but has 4", 1)],
  "questions-6": [err("the quiz must have exactly 5 questions but has 6", 1)],
  "questions-empty": [err("the quiz must have exactly 5 questions but has 0", 1)],
  "options-1": [err(`${q(3)}: must have 2 or 3 options but has 1`, 24)],
  "options-4": [err(`${q(3)}: must have 2 or 3 options but has 4`, 24)],
  // rules: the correct option and repeated IDs
  "correct-no-match": [err(`${q(2)}: \`correct\` does not match the id of any option`, 19)],
  "correct-matches-two-options": [err(`${q(2)}: option id \`a\` is already used by the option on line 15`, 19)],
  "option-id-repeated": [err(`${q(2)}: option id \`a\` is already used by the option on line 15`, 19)],
  "option-text-repeated": [err(`${q(2)}: option \`a\` and option \`c\` have the same text`, 20)],
  "question-id-repeated": [
    err(`${q(1)}: the id is already used by the question at ${FIRST_QUIZ}:2`, 22),
  ],
  // rules: lesson links
  "lesson-missing": [err(`${q(2)}: \`lesson\` is \`no-such-lesson\`, but this chapter has no lesson with that id`, 21)],
  "lesson-of-another-chapter": [err(`${q(2)}: \`lesson\` is \`01-next\`, but this chapter has no lesson with that id`, 21)],
  "lesson-wrong-case": [err(`${q(2)}: \`lesson\` is \`01-Welcome\`, but this chapter has no lesson with that id`, 21)],
  "lesson-file-name-when-id-set": [err(`${q(2)}: \`lesson\` is \`02-setup\`, but this chapter has no lesson with that id`, 21)],
  // rules: lengths and empty values
  "explanation-too-long": [err(`${q(2)}: \`explanation\` has 1001 characters; the limit is 1000`, 20)],
  "explanation-empty": [err(`${q(2)}: \`explanation\` must not be empty`, 20)],
  "snippet-code-too-long": [err(`${q(2)}, snippet: \`code\` has 2001 characters; the limit is 2000`, 16)],
  "snippet-code-empty": [err(`${q(2)}, snippet: \`code\` must not be empty`, 16)],
  "snippet-without-language": [err(`${q(2)}, snippet: missing required field \`language\``, 14)],
  "question-text-empty": [err(`${q(2)}: \`text\` must not be empty`, 13)],
  "option-text-whitespace-only": [err(`${q(2)}, option \`a\`: \`text\` must not be empty`, 16)],
};

describe("invalid quiz fixtures", () => {
  it.each(Object.entries(invalid))("%s", (name, expected) => {
    expect(check(quizFixture("invalid", name))).toEqual(expected);
  });

  it("has an expected list for every fixture and a fixture for every list", () => {
    expect(files("invalid")).toEqual(Object.keys(invalid).sort());
  });
});

describe("a course whose quiz repeats a question ID of another chapter", () => {
  // The fixture course itself is checked in fixtures.test.ts.
  it("prints the problem and exits 1 through the command", () => {
    let stdout = "";
    const code = main(["fixtures/invalid/quiz-question-id-repeated-across-chapters"], { stdout: (t) => (stdout += t), stderr: () => {} });

    expect(code).toBe(1);
    expect(stdout).toBe(
      "fixtures/invalid/quiz-question-id-repeated-across-chapters/chapters/02-more/quiz.yaml:25: error: " +
        "question `01-intro-q3`: the id is already used by the question at chapters/01-intro/quiz.yaml:25\n" +
        "1 error(s), 0 warning(s)\n",
    );
  });

  it("counts the first chapter as the first use whatever the order of the files", () => {
    const first = quizFixture("valid", "two-options-no-snippet");
    const second = first.replaceAll("first-steps-", "going-further-").replace("going-further-3", "first-steps-3").replaceAll("lesson: 01-welcome", "lesson: 01-next");

    expect(check(first, { [SECOND_QUIZ]: second })).toEqual([
      error(SECOND_QUIZ, `question \`first-steps-3\`: the id is already used by the question at ${FIRST_QUIZ}:22`, 22),
    ]);
  });

  it("allows the same IDs in two different courses", () => {
    const other = makeCourse("other-course", { "course.yaml": courseYaml({ id: "other-course" }) });

    const sample = makeCourse("sample-course");

    expect(validateCourse(sample)).toEqual([]);
    expect(validateCourse(other)).toEqual([]);
    expect(validateCourse(sample)).toEqual([]);
  });
});

// A valid quiz as JSON, which is YAML too. `edit` changes it before it is written, so one test line can
// make a mistake in one place. Question 2 has a snippet.
type Json = Record<string, unknown>;
function quizJson(edit: (questions: Json[]) => void = () => {}): string {
  const questions: Json[] = [1, 2, 3, 4, 5].map((n) => ({
    id: `first-steps-${n}`,
    text: `Question number ${n}?`,
    ...(n === 2 ? { snippet: { language: "python", code: "print(1)" } } : {}),
    options: [
      { id: "a", text: `Option A of question ${n}` },
      { id: "b", text: `Option B of question ${n}` },
    ],
    correct: "a",
    explanation: `Explanation ${n}.`,
    lesson: "01-welcome",
  }));
  edit(questions);
  return `${JSON.stringify({ questions }, null, 2)}\n`;
}

/** The 1-based line of the text that holds `fragment` and is unique in `text`. */
function lineWith(text: string, fragment: string): number {
  const lines = text.split("\n").flatMap((line, index) => (line.includes(fragment) ? [index + 1] : []));
  if (lines.length !== 1) throw new Error(`${fragment} is on ${lines.length} lines`);
  return lines[0] as number;
}

/** The line of the nth (from 1) line that is exactly `exact`. */
function nthLine(text: string, exact: string, n: number): number {
  const lines = text.split("\n").flatMap((line, index) => (line === exact ? [index + 1] : []));
  return lines[n - 1] as number;
}

/** The line of the key `field` of question `n`: the keys of a question are indented 6 spaces in `quizJson`. */
function questionKeyLine(text: string, field: string, n: number): number {
  const lines = text.split("\n").flatMap((line, index) => (line.startsWith(`      "${field}":`) ? [index + 1] : []));
  return lines[n - 1] as number;
}

const QUESTION_ITEM = "    {";
const OPTION_ITEM = "        {";
const question2 = (text: string) => nthLine(text, QUESTION_ITEM, 2);

describe("a quiz written as JSON", () => {
  it("is valid before any change", () => {
    expect(check(quizJson())).toEqual([]);
  });
});

describe("required fields", () => {
  it.each(["text", "options", "correct", "explanation", "lesson"])("reports a question without %s", (field) => {
    const text = quizJson((questions) => delete questions[1]?.[field]);

    expect(check(text)).toEqual([err(`${q(2)}: missing required field \`${field}\``, question2(text))]);
  });

  it("names a question without an id by its position", () => {
    const text = quizJson((questions) => delete questions[1]?.id);

    expect(check(text)).toEqual([err("question 2: missing required field `id`", question2(text))]);
  });

  it("reports an option without an id, naming the option by its position", () => {
    const text = quizJson((questions) => delete (questions[1]?.options as Json[])[1]?.id);

    expect(check(text)).toEqual([
      err(`${q(2)}, option 2: missing required field \`id\``, nthLine(text, OPTION_ITEM, 4)),
    ]);
  });

  it("reports an option without text", () => {
    const text = quizJson((questions) => delete (questions[1]?.options as Json[])[1]?.text);

    expect(check(text)).toEqual([
      err(`${q(2)}, option \`b\`: missing required field \`text\``, nthLine(text, OPTION_ITEM, 4)),
    ]);
  });

  it.each(["language", "code"])("reports a snippet without %s", (field) => {
    const text = quizJson((questions) => delete (questions[1]?.snippet as Json)[field]);

    expect(check(text)).toEqual([err(`${q(2)}, snippet: missing required field \`${field}\``, lineWith(text, '"snippet"'))]);
  });

  it("reports a quiz without questions", () => {
    expect(check("{}\n")).toEqual([err("missing required field `questions`")]);
  });

  it("reports an empty file as a quiz without questions", () => {
    expect(check("")).toEqual([err("missing required field `questions`")]);
    expect(check("# only a comment\n")).toEqual([err("missing required field `questions`")]);
  });
});

describe("wrong types", () => {
  const values: [string, unknown][] = [
    ["a number", 42],
    ["a boolean", true],
    ["null", null],
    ["a list", ["x"]],
    ["a mapping", { x: 1 }],
  ];

  describe.each(["text", "correct", "explanation", "lesson"])("%s of a question", (field) => {
    it.each(values)("rejects %s", (_name, value) => {
      const text = quizJson((questions) => ((questions[1] as Json)[field] = value));

      expect(check(text)).toEqual([err(`${q(2)}: \`${field}\` must be a string`, questionKeyLine(text, field, 2))]);
    });
  });

  it.each(values)("rejects %s as the id of a question and names the question by its position", (_name, value) => {
    const text = quizJson((questions) => ((questions[1] as Json).id = value));

    expect(check(text).map((p) => p.message)).toEqual(["question 2: `id` must be a string"]);
  });

  it("rejects an id that is a YAML boolean, as an author would write it", () => {
    const text = quizFixture("valid", "two-options-no-snippet").replace("id: first-steps-2", "id: true");

    expect(check(text)).toEqual([err("question 2: `id` must be a string", 12)]);
  });

  it("rejects text that is a YAML number, as an author would write it", () => {
    const text = quizFixture("valid", "two-options-no-snippet").replace("text: Question number 2?", "text: 42");

    expect(check(text)).toEqual([err(`${q(2)}: \`text\` must be a string`, 13)]);
  });

  it.each(["id", "text"])("rejects an option %s that is a number", (field) => {
    const text = quizJson((questions) => {
      ((questions[1]?.options as Json[])[0] as Json)[field] = 7;
      (questions[1] as Json).correct = "b";
    });
    const message = field === "id" ? `${q(2)}, option 1: \`id\` must be a string` : `${q(2)}, option \`a\`: \`text\` must be a string`;

    expect(check(text).map((p) => p.message)).toEqual([message]);
  });

  it.each(["language", "code"])("rejects a snippet %s that is a number", (field) => {
    const text = quizJson((questions) => ((questions[1]?.snippet as Json)[field] = 7));

    expect(check(text).map((p) => p.message)).toEqual([`${q(2)}, snippet: \`${field}\` must be a string`]);
  });

  it("rejects options that are not a list", () => {
    const text = quizJson((questions) => ((questions[1] as Json).options = "a"));

    expect(check(text)).toEqual([err(`${q(2)}: \`options\` must be a list`, lineWith(text, '"options": "a"'))]);
  });

  it("rejects an option that is not a mapping", () => {
    const text = quizJson((questions) => ((questions[1]?.options as unknown[])[1] = "b"));

    expect(check(text).map((p) => p.message)).toEqual([`${q(2)}, option 2 must be a mapping of keys to values`]);
  });

  it("rejects a snippet that is not a mapping", () => {
    const text = quizJson((questions) => ((questions[1] as Json).snippet = "print(1)"));

    expect(check(text)).toEqual([err(`${q(2)}: \`snippet\` must be a mapping of keys to values`, lineWith(text, '"snippet"'))]);
  });
});

describe("the shape of ids and the language", () => {
  it.each(["Upper-Case", "with space", "under_score", "", "ü"])("rejects the question id %j without quoting it", (id) => {
    const text = quizJson((questions) => ((questions[1] as Json).id = id));

    expect(check(text).map((p) => p.message)).toEqual([
      id === "" ? "question 2: `id` must not be empty" : `question 2: \`id\` ${ID_RULE}`,
    ]);
  });

  it("rejects an option id with capitals", () => {
    const text = quizJson((questions) => {
      ((questions[1]?.options as Json[])[0] as Json).id = "A";
      (questions[1] as Json).correct = "b";
    });

    expect(check(text).map((p) => p.message)).toEqual([`${q(2)}, option 1: \`id\` ${ID_RULE}`]);
  });

  it.each(["py thon", "py\tthon", " python", "python "])("rejects the language %j", (language) => {
    const text = quizJson((questions) => ((questions[1]?.snippet as Json).language = language));

    expect(check(text).map((p) => p.message)).toEqual([`${q(2)}, snippet: \`language\` must not contain white space`]);
  });

  it("rejects an empty language", () => {
    const text = quizJson((questions) => ((questions[1]?.snippet as Json).language = ""));

    expect(check(text).map((p) => p.message)).toEqual([`${q(2)}, snippet: \`language\` must not be empty`]);
  });

  it.each(["c++", "text", "python3", "x-y"])("accepts the language %s", (language) => {
    expect(check(quizJson((questions) => ((questions[1]?.snippet as Json).language = language)))).toEqual([]);
  });
});

describe("empty and whitespace-only text", () => {
  it.each(["text", "explanation"])("rejects a %s of only white space", (field) => {
    const text = quizJson((questions) => ((questions[1] as Json)[field] = " \t\n "));

    expect(check(text).map((p) => p.message)).toEqual([`${q(2)}: \`${field}\` must not be empty`]);
  });

  it("rejects an option text and a snippet code of only white space", () => {
    const text = quizJson((questions) => {
      ((questions[1]?.options as Json[])[1] as Json).text = "   ";
      (questions[1]?.snippet as Json).code = "\n\n  \n";
    });

    expect(check(text).map((p) => p.message)).toEqual([
      `${q(2)}, option \`b\`: \`text\` must not be empty`,
      `${q(2)}, snippet: \`code\` must not be empty`,
    ]);
  });

  it("rejects an empty lesson", () => {
    const text = quizJson((questions) => ((questions[1] as Json).lesson = ""));

    expect(check(text).map((p) => p.message)).toEqual([`${q(2)}: \`lesson\` must not be empty`]);
  });
});

describe("the correct option", () => {
  it("rejects an empty correct", () => {
    const text = quizJson((questions) => ((questions[1] as Json).correct = ""));

    expect(check(text).map((p) => p.message)).toEqual([`${q(2)}: \`correct\` does not match the id of any option`]);
  });

  it("does not find the option with another case", () => {
    const text = quizJson((questions) => ((questions[1] as Json).correct = "A"));

    expect(check(text).map((p) => p.message)).toEqual([`${q(2)}: \`correct\` does not match the id of any option`]);
  });

  it("accepts any of the options as the correct one", () => {
    for (const correct of ["a", "b"]) {
      expect(check(quizJson((questions) => ((questions[1] as Json).correct = correct)))).toEqual([]);
    }
  });

  it("reports one message, not two, for two options with the correct id", () => {
    const text = quizJson((questions) => {
      ((questions[1]?.options as Json[])[1] as Json).id = "a";
    });

    expect(check(text).map((p) => p.message)).toEqual([`${q(2)}: option id \`a\` is already used by the option on line ${nthLine(text, OPTION_ITEM, 3) + 1}`]);
  });
});

describe("repeated option text", () => {
  const sameText = (a: string, b: string) =>
    check(
      quizJson((questions) => {
        ((questions[1]?.options as Json[])[0] as Json).text = a;
        ((questions[1]?.options as Json[])[1] as Json).text = b;
      }),
    ).map((p) => p.message);

  it("compares the text after trimming white space", () => {
    expect(sameText("Same", "  Same\n")).toEqual([`${q(2)}: option \`a\` and option \`b\` have the same text`]);
  });

  it("compares the text with the same case", () => {
    expect(sameText("Same", "same")).toEqual([]);
  });

  it("does not report the text that is repeated in another question", () => {
    const text = quizJson((questions) => {
      ((questions[2]?.options as Json[])[0] as Json).text = "Option A of question 1";
    });

    expect(check(text)).toEqual([]);
  });

  it("does not report the text of the options together with an id that is repeated", () => {
    const text = quizJson((questions) => {
      questions[1]!.options = [{ id: "a", text: "Same" }, { id: "a", text: "Same" }, { id: "b", text: "Other" }];
    });

    expect(check(text).map((p) => p.message)).toHaveLength(1);
  });
});

describe("limits count Unicode characters", () => {
  const withExplanation = (explanation: string) => check(quizJson((questions) => ((questions[1] as Json).explanation = explanation)));
  const withCode = (code: string) => check(quizJson((questions) => ((questions[1]?.snippet as Json).code = code)));

  it("accepts 1000 characters of explanation and rejects 1001", () => {
    expect(withExplanation("x".repeat(1000))).toEqual([]);
    expect(withExplanation("x".repeat(1001)).map((p) => p.message)).toEqual([
      `${q(2)}: \`explanation\` has 1001 characters; the limit is 1000`,
    ]);
  });

  it("accepts 2000 characters of code and rejects 2001", () => {
    expect(withCode("x".repeat(2000))).toEqual([]);
    expect(withCode("x".repeat(2001)).map((p) => p.message)).toEqual([
      `${q(2)}, snippet: \`code\` has 2001 characters; the limit is 2000`,
    ]);
  });

  it("counts a character outside the Basic Multilingual Plane once", () => {
    // Each of these is two UTF-16 units, so the limit would be passed if units were counted.
    expect("😀".length).toBe(2);
    expect(withExplanation("😀".repeat(1000))).toEqual([]);
    expect(withExplanation("😀".repeat(1001)).map((p) => p.message)).toEqual([
      `${q(2)}: \`explanation\` has 1001 characters; the limit is 1000`,
    ]);
    expect(withCode("😀".repeat(2000))).toEqual([]);
    expect(withCode("😀".repeat(2001))).toHaveLength(1);
  });

  it("counts a combining mark as a character of its own", () => {
    expect(withExplanation("é".repeat(500))).toEqual([]);
    expect(withExplanation("é".repeat(501))).toHaveLength(1);
  });

  it("counts a CRLF in the code as one character, so Windows and Linux agree", () => {
    // 1000 lines of "a" + CRLF are 3000 characters in the file and 2000 after CRLF becomes LF.
    expect(withCode("a\r\n".repeat(1000))).toEqual([]);
    expect(withCode("a\r\n".repeat(1001))).toHaveLength(1);
  });

  it("does not count the white space around an explanation", () => {
    expect(withExplanation(`  \r\n${"x".repeat(1000)}\r\n  `)).toEqual([]);
  });

  it("counts a block of code the same in a file with CRLF line endings", () => {
    // A block of 1000 lines of "a" is 2000 characters with its line breaks.
    const withBlock = (lines: number) =>
      quizFixture("valid", "two-options-no-snippet").replace(
        "    options:",
        `    snippet:\n      language: text\n      code: |\n${"        a\n".repeat(lines)}    options:`,
      );

    for (const toFile of [(text: string) => text, (text: string) => text.replaceAll("\n", "\r\n")]) {
      expect(check(toFile(withBlock(1000)))).toEqual([]);
      expect(check(toFile(withBlock(1001))).map((p) => p.message)).toEqual([
        `${q(1)}, snippet: \`code\` has 2002 characters; the limit is 2000`,
      ]);
    }
  });
});

describe("lesson links", () => {
  it("accepts the file name of a lesson and the explicit id of another", () => {
    const text = quizJson((questions) => {
      (questions[0] as Json).lesson = "01-welcome";
      (questions[1] as Json).lesson = "setup";
    });

    expect(check(text)).toEqual([]);
  });

  it("does not use the file name of a lesson that has an explicit id", () => {
    const text = quizJson((questions) => ((questions[1] as Json).lesson = "02-setup"));

    expect(check(text).map((p) => p.message)).toEqual([
      `${q(2)}: \`lesson\` is \`02-setup\`, but this chapter has no lesson with that id`,
    ]);
  });

  it("falls back to the file name when the explicit id is not valid", () => {
    const lesson = "---\ntitle: Welcome\norder: 1\nid: Not Valid\n---\n";
    const problems = check(quizJson(), { "chapters/01-first-steps/lessons/01-welcome.mdx": lesson });

    expect(problems).toEqual([
      error("chapters/01-first-steps/lessons/01-welcome.mdx", `\`id\` ${ID_RULE} (got "Not Valid")`, 4),
    ]);
  });

  it("links to a lesson whose file name is not valid by that name", () => {
    const text = quizJson((questions) => ((questions[1] as Json).lesson = "Odd"));
    const problems = check(text, { "chapters/01-first-steps/lessons/Odd.mdx": "---\ntitle: Odd\norder: 3\n---\n" });

    expect(problems.map((p) => p.file)).toEqual(["chapters/01-first-steps/lessons/Odd.mdx"]);
  });

  it("does not check the links when lessons/ is missing, which is reported already", () => {
    const text = quizJson((questions) => ((questions[1] as Json).lesson = "no-such-lesson"));

    expect(check(text, { "chapters/01-first-steps/lessons": null })).toEqual([
      error("chapters/01-first-steps/lessons", "the lessons/ folder is missing"),
    ]);
  });

  it("does not check the links when lessons/ has no lessons, which is reported already", () => {
    const text = quizJson((questions) => ((questions[1] as Json).lesson = "no-such-lesson"));
    const problems = check(text, {
      "chapters/01-first-steps/lessons/01-welcome.mdx": null,
      "chapters/01-first-steps/lessons/02-setup.mdx": null,
    });

    expect(problems.map((p) => p.message)).toEqual(["lessons/ must contain at least one .mdx lesson file"]);
  });

  it("compares exactly, so another case does not match", () => {
    const text = quizJson((questions) => ((questions[1] as Json).lesson = "01-WELCOME"));

    expect(check(text)).toHaveLength(1);
  });

  it("links by the lesson names of its own chapter only", () => {
    const text = quizJson((questions) => ((questions[1] as Json).lesson = "01-next"));
    const other = quizFixture("valid", "two-options-no-snippet").replaceAll("first-steps-", "going-further-").replaceAll("lesson: 01-welcome", "lesson: 01-next");

    expect(check(text, { [SECOND_QUIZ]: other })).toHaveLength(1);
    expect(check(quizJson(), { [SECOND_QUIZ]: other })).toEqual([]);
  });
});

describe("which quiz files are checked", () => {
  it("does not report a missing quiz.yaml again", () => {
    expect(check("", { [FIRST_QUIZ]: null })).toEqual([error(FIRST_QUIZ, "quiz.yaml is missing")]);
  });

  it("does not check the quiz of a chapter that is not listed", () => {
    const problems = check(quizJson(), {
      "chapters/03-extra/quiz.yaml": "questions: []\n",
      "chapters/03-extra/lessons/01-a.mdx": "---\ntitle: A\norder: 1\n---\n",
    });

    expect(problems.map((p) => [p.file, p.severity])).toEqual([["chapters/03-extra", "error"]]);
  });

  it("checks the quiz of every listed chapter", () => {
    const problems = check(quizJson(), { [SECOND_QUIZ]: "questions: []\n" });

    expect(problems).toEqual([error(SECOND_QUIZ, "the quiz must have exactly 5 questions but has 0", 1)]);
  });

  it("reports an unreadable quiz.yaml", () => {
    const course = makeCourse("sample-course");
    writeFileSync(join(course, ...FIRST_QUIZ.split("/")), Buffer.from([0xff, 0xfe, 0x00]));

    expect(validateCourse(course)).toEqual([error(FIRST_QUIZ, "the file is not valid UTF-8")]);
  });
});

describe("all the problems of a quiz come in one run", () => {
  it("reports shape problems and rule problems together, each with its question", () => {
    const text = quizJson((questions) => {
      questions[0]!.hint = "x";
      delete questions[1]!.explanation;
      questions[2]!.text = 42;
      questions[3]!.correct = "z";
      questions.pop();
    });

    expect(check(text).map((p) => p.message)).toEqual([
      `${q(1)}: unknown key \`hint\``,
      `${q(2)}: missing required field \`explanation\``,
      `${q(3)}: \`text\` must be a string`,
      `${q(4)}: \`correct\` does not match the id of any option`,
      "the quiz must have exactly 5 questions but has 4",
    ]);
  });

  it("gives each problem the quiz file and the line of the key or list item", () => {
    const text = quizJson((questions) => {
      questions[0]!.hint = "x";
      questions[2]!.text = 42;
    });
    const problems = check(text);

    expect(problems.map((p) => p.file)).toEqual([FIRST_QUIZ, FIRST_QUIZ]);
    expect(problems.map((p) => p.line)).toEqual([lineWith(text, '"hint"'), lineWith(text, '"text": 42')]);
  });
});

describe("what the problems say", () => {
  // The quiz is private build data: a message uses ids, counts, line numbers, and file paths only.
  const SENTINELS = ["TEXT-SENTINEL-4c1e", "OPTION-SENTINEL-4c1e", "EXPLANATION-SENTINEL-4c1e", "CODE-SENTINEL-4c1e", "KEY-SENTINEL-4c1e"];

  /** A quiz that fails many rules and has a sentinel in every kind of content. */
  function sentinelQuiz(): string {
    return quizJson((questions) => {
      const [first, second, third, fourth] = questions as [Json, Json, Json, Json];
      first.text = SENTINELS[0];
      first.options = [
        { id: "a", text: SENTINELS[1] },
        { id: "b", text: ` ${SENTINELS[1]} ` },
        { id: "a", text: "Other" },
        { id: "d", text: "Fourth" },
      ];
      first.correct = "key-sentinel-4c1e";
      first.explanation = `${SENTINELS[2]} ${"x".repeat(1000)}`;
      first.snippet = { language: "python", code: `${SENTINELS[3]} ${"y".repeat(2000)}` };
      second.text = 42;
      second.explanation = SENTINELS[2];
      second.lesson = "nowhere";
      second.correct = "key-sentinel-4c1e";
      (second.snippet as Json).code = SENTINELS[3];
      third.options = [{ id: "a", text: SENTINELS[1] }];
      third.correct = "key-sentinel-4c1e";
      delete fourth.explanation;
      fourth.hint = SENTINELS[2];
      questions.push({ id: "first-steps-1", text: SENTINELS[0], options: [], correct: "a", explanation: SENTINELS[2], lesson: "a" });
    });
  }

  it("never quotes question text, option text, an explanation, code, or the correct option", () => {
    const course = makeCourse("sample-course", { [FIRST_QUIZ]: sentinelQuiz() });
    let stdout = "";
    const code = main([course], { stdout: (t) => (stdout += t), stderr: (t) => (stdout += t) });

    expect(code).toBe(1);
    // It reports a lot, so the sentinels would show up if any message quoted content.
    expect(stdout.split("\n").length).toBeGreaterThan(8);
    for (const sentinel of [...SENTINELS, "key-sentinel-4c1e"]) {
      expect(stdout.toLowerCase()).not.toContain(sentinel.toLowerCase());
    }
  });

  it("reports the problems of the sentinel quiz that this test is about", () => {
    const messages = check(sentinelQuiz()).map((p) => p.message);

    expect(messages).toContain(`${q(1)}: \`explanation\` has ${SENTINELS[2]!.length + 1001} characters; the limit is 1000`);
    expect(messages).toContain(`${q(1)}, snippet: \`code\` has ${SENTINELS[3]!.length + 2001} characters; the limit is 2000`);
    expect(messages).toContain(`${q(1)}: \`correct\` does not match the id of any option`);
    expect(messages).toContain(`${q(1)}: must have 2 or 3 options but has 4`);
    expect(messages).toContain(`${q(1)}: option \`a\` and option \`b\` have the same text`);
    expect(messages).toContain(`${q(2)}: \`text\` must be a string`);
    expect(messages).toContain(`${q(3)}: must have 2 or 3 options but has 1`);
    expect(messages).toContain(`${q(4)}: unknown key \`hint\``);
  });
});
