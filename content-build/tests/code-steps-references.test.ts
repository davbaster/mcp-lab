// A CodeSteps tag must name a step of its chapter's code/ and a file in that step. The rejections are in fixtures.test.ts.

import { describe, expect, it } from "vitest";
import { validateCourse } from "../src/course.ts";
import { lessonText, makeCourse } from "./helpers.ts";

const WELCOME = "chapters/01-first-steps/lessons/01-welcome.mdx";
const lessonWith = (body: string) => `${lessonText("Welcome", 1)}\n${body}\n`;

const problems = (body: string, changes: Record<string, string | null> = {}) => validateCourse(makeCourse("sample-course", { [WELCOME]: lessonWith(body), ...changes }));

describe("CodeSteps tags that name a real step and file", () => {
  it("are accepted: with or without a file, in any step, also inside a Callout and a Tab", () => {
    const body = [
      '<CodeSteps step="1" />',
      '<CodeSteps step="3" file="settings.txt" />',
      '<CodeSteps step="2" file="pkg/util.py" />',
      '<CodeSteps step="1" file="main.py" />',
      '<Callout type="note">\n\n<CodeSteps step="3" file="pkg/__init__.py" />\n\n</Callout>',
      '<Tabs>\n\n<Tab label="One">\n\n<CodeSteps step="2" file="helper.py" />\n\n</Tab>\n\n<Tab label="Two">\n\nText.\n\n</Tab>\n\n</Tabs>',
    ].join("\n\n");

    expect(problems(body)).toEqual([]);
  });

  it("are checked against the chapter of the lesson, not against another chapter's code", () => {
    // The second chapter has no code/ folder, though the first has three steps.
    const body = '<CodeSteps step="1" file="main.py" />';
    const result = problems("Text.", { "chapters/02-going-further/lessons/01-next.mdx": null });
    expect(result.some((problem) => problem.message.includes("CodeSteps"))).toBe(false);

    const other = validateCourse(
      makeCourse("sample-course", { "chapters/02-going-further/lessons/01-next.mdx": lessonWith(body).replace("Welcome", "Next steps") }),
    );
    expect(other.filter((problem) => problem.severity === "error").map((problem) => problem.message)).toEqual([
      "`<CodeSteps>` shows step 1, but chapter `02-going-further` has no code/ folder; add the steps or remove the tag",
    ]);
  });

  it("are not checked in a lesson that has no CodeSteps tag, even in a chapter with no code", () => {
    expect(problems("Plain text.", { "chapters/01-first-steps/code": null })).toEqual([]);
  });

  it("report each tag once, with the line and column of the tag", () => {
    const body = '<CodeSteps step="9" />\n\n  <Callout type="tip">\n\n<CodeSteps step="9" file="main.py" />\n\n  </Callout>';
    const errors = problems(body).filter((problem) => problem.severity === "error");

    expect(errors.map((problem) => [problem.line, problem.column])).toEqual([
      [8, 1],
      [12, 1],
    ]);
    expect(errors.every((problem) => problem.file === WELCOME)).toBe(true);
    expect(errors[0]?.message).toBe("`<CodeSteps>` shows step 9, but chapter `01-first-steps` has the steps 1 to 3");
  });

  it("are not checked when the lesson itself is rejected, so one problem is reported", () => {
    const errors = problems('{1 + 1}\n\n<CodeSteps step="9" />').filter((problem) => problem.severity === "error");

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("JavaScript expressions");
  });
});
