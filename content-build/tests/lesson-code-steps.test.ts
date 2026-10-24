// compileLesson also returns the CodeSteps tags it found, with the position of each tag, next to the tree.

import { describe, expect, it } from "vitest";
import { compileLesson } from "../src/lesson.ts";

const HEADER = "---\ntitle: Case\norder: 1\n---\n\n";

function codeSteps(body: string) {
  const result = compileLesson(`${HEADER}${body}\n`, { path: "lessons/case.mdx" });
  if ("problems" in result) throw new Error(`unexpected problems: ${JSON.stringify(result.problems)}`);
  return result.codeSteps;
}

describe("compileLesson codeSteps", () => {
  it("lists each tag with its step, its file when it has one, and the line and column of the tag", () => {
    expect(codeSteps('<CodeSteps step="2" file="server.py" />\n\nText.\n\n<CodeSteps step="10" />')).toEqual([
      { step: "2", file: "server.py", line: 6, column: 1 },
      { step: "10", line: 10, column: 1 },
    ]);
  });

  it("finds the tags inside a Callout and a Tab, at the column where the tag starts", () => {
    const body = [
      '<Callout type="tip">',
      "",
      '<CodeSteps step="1" file="a.py" />',
      "",
      "</Callout>",
      "",
      "<Tabs>",
      "",
      '<Tab label="One">',
      "",
      '  <CodeSteps step="2" file="b/c.py" />',
      "",
      "</Tab>",
      "",
      '<Tab label="Two">',
      "",
      "Text.",
      "",
      "</Tab>",
      "",
      "</Tabs>",
    ].join("\n");

    expect(codeSteps(body)).toEqual([
      { step: "1", file: "a.py", line: 8, column: 1 },
      { step: "2", file: "b/c.py", line: 16, column: 3 },
    ]);
  });

  it("returns an empty list for a lesson without the tag", () => {
    expect(codeSteps("Just text.")).toEqual([]);
  });

  it("gives the same positions for CRLF line endings", () => {
    const lf = `${HEADER}Text.\n\n<CodeSteps step="1" file="a.py" />\n`;
    const crlf = compileLesson(lf.replaceAll("\n", "\r\n"), { path: "lessons/case.mdx" });
    if ("problems" in crlf) throw new Error("unexpected problems");

    expect(crlf.codeSteps).toEqual([{ step: "1", file: "a.py", line: 8, column: 1 }]);
  });

  it("does not return the tags of a lesson that is rejected", () => {
    const result = compileLesson(`${HEADER}<CodeSteps step="0" />\n`, { path: "lessons/case.mdx" });

    expect("problems" in result).toBe(true);
  });
});
