// diffSteps and the text helpers work on steps in memory (path to text), so these tests need no disk.

import { describe, expect, it } from "vitest";
import { diffSteps } from "../src/step-diff.ts";
import type { StepJson } from "../src/step-diff.ts";
import { normalizeText, splitLines } from "../src/text.ts";

type Files = Record<string, string>;
const step = (number: number, files: Files) => ({ step: number, files: new Map(Object.entries(files)) });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
/** One file of the second step: its status and changed lines. */
const change = (before: string, after: string, path = "f.txt") => {
  const file = diffSteps([step(1, { [path]: before }), step(2, { [path]: after })])[1]?.files.find((f) => f.path === path);
  return file === undefined ? undefined : { status: file.status, changed_lines: file.changed_lines, content: file.content };
};
const summary = (steps: StepJson[]) => steps.map((s) => [s.step, s.files.map((f) => `${f.path}:${f.status}`)]);

describe("normalizeText", () => {
  it("turns CRLF into LF and removes one leading byte order mark", () => {
    expect(normalizeText("﻿a\r\nb\r\n")).toBe("a\nb\n");
  });

  it("removes only one byte order mark", () => {
    expect(normalizeText("﻿﻿a")).toBe("﻿a");
  });

  it("removes a byte order mark only at the start", () => {
    expect(normalizeText("a﻿b")).toBe("a﻿b");
  });

  it("keeps a lone CR, trailing spaces, tabs, and a missing final newline", () => {
    expect(normalizeText("a\rb \t\nc  ")).toBe("a\rb \t\nc  ");
  });

  it("turns CR CR LF into CR LF, not into two line endings", () => {
    expect(normalizeText("a\r\r\nb")).toBe("a\r\nb");
  });

  it("changes nothing in text that is already normalized", () => {
    const text = "x = 1\n\nprint(x)\n";

    expect(normalizeText(normalizeText(text))).toBe(text);
    expect(normalizeText("")).toBe("");
    expect(normalizeText("﻿")).toBe("");
  });
});

describe("lines", () => {
  it("counts the lines of a file: N lines are numbered 1 to N, and a final newline adds none", () => {
    expect(splitLines("a\nb\nc")).toHaveLength(3);
    expect(splitLines("a\nb\nc\n")).toHaveLength(3);
    expect(splitLines("\n")).toHaveLength(1);
    expect(splitLines("\n\n")).toHaveLength(2);
    expect(splitLines("a")).toHaveLength(1);
  });

  it("gives an empty file no lines", () => {
    expect(splitLines("")).toEqual([]);
    expect(diffSteps([step(1, { "empty.py": "" })])[0]?.files).toEqual([
      { path: "empty.py", status: "added", content: "", changed_lines: [] },
    ]);
  });

  it("does not split at a lone CR", () => {
    expect(splitLines("a\rb\nc\n")).toHaveLength(2);
    expect(change("a\rb\nc\n", "a\rb\nd\n")?.changed_lines).toEqual([2]);
  });
});

describe("step 1", () => {
  it("lists all its files as added, with every line changed", () => {
    expect(diffSteps([step(1, { "main.py": "a\nb\nc\n", "util.py": "x" })])).toEqual([
      {
        step: 1,
        files: [
          { path: "main.py", status: "added", content: "a\nb\nc\n", changed_lines: [1, 2, 3] },
          { path: "util.py", status: "added", content: "x", changed_lines: [1] },
        ],
      },
    ]);
  });

  it("returns nothing for no steps", () => {
    expect(diffSteps([])).toEqual([]);
  });
});

describe("statuses", () => {
  const steps = diffSteps([
    step(1, { "same.py": "s\n", "edit.py": "a\n", "gone.py": "g\n", "old-name.py": "n\n" }),
    step(2, { "same.py": "s\n", "edit.py": "b\n", "new.py": "w\n", "new-name.py": "n\n" }),
  ]);

  it("lists every file of the step plus the files of the previous step that are gone", () => {
    expect(summary(steps)).toEqual([
      [1, ["edit.py:added", "gone.py:added", "old-name.py:added", "same.py:added"]],
      [2, ["edit.py:modified", "gone.py:deleted", "new-name.py:added", "new.py:added", "old-name.py:deleted", "same.py:unchanged"]],
    ]);
  });

  it("treats a renamed file as a deleted file and an added file, with no rename detection", () => {
    const files = steps[1]!.files;

    expect(files.find((f) => f.path === "old-name.py")).toMatchObject({ status: "deleted", changed_lines: [] });
    expect(files.find((f) => f.path === "new-name.py")).toMatchObject({ status: "added", changed_lines: [1] });
  });

  it("gives a deleted file the empty content and no changed lines, and the others their text", () => {
    const files = steps[1]!.files;

    expect(files.find((f) => f.path === "gone.py")).toEqual({ path: "gone.py", status: "deleted", content: "", changed_lines: [] });
    expect(files.find((f) => f.path === "same.py")).toEqual({ path: "same.py", status: "unchanged", content: "s\n", changed_lines: [] });
    expect(files.find((f) => f.path === "edit.py")?.content).toBe("b\n");
  });

  it("lists a file deleted in step 2 only in step 2, and an added-back file as added", () => {
    const three = diffSteps([step(1, { "a.py": "1" }), step(2, {}), step(3, { "a.py": "1" })]);

    expect(summary(three)).toEqual([[1, ["a.py:added"]], [2, ["a.py:deleted"]], [3, ["a.py:added"]]]);
  });

  it("makes every file of a step identical to the previous one unchanged", () => {
    const same = { "a.py": "x\n", "b/c.py": "y\n" };

    expect(summary(diffSteps([step(1, same), step(2, same)]))[1]).toEqual([2, ["a.py:unchanged", "b/c.py:unchanged"]]);
  });

  it("compares a file with the same path in the previous step only", () => {
    const three = diffSteps([step(1, { "a.py": "1\n" }), step(2, { "a.py": "2\n" }), step(3, { "a.py": "1\n" })]);

    expect(three[2]?.files[0]).toMatchObject({ status: "modified", changed_lines: [1] });
  });
});

describe("changed lines", () => {
  it("lists the new and the changed lines of the new version, ascending", () => {
    expect(change("a\nb\nc\nd\n", "a\nX\nc\nd\nnew\n")?.changed_lines).toEqual([2, 5]);
  });

  it("lists inserted lines at their new numbers", () => {
    expect(change("a\nb\n", "a\nins1\nins2\nb\n")?.changed_lines).toEqual([2, 3]);
  });

  it("has no repeats, whatever repeated lines the file has", () => {
    const lines = change("x\nx\nx\n", "x\nx\ny\nx\nx\n")?.changed_lines ?? [];

    expect(new Set(lines).size).toBe(lines.length);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    expect(lines).toHaveLength(2);
  });

  it("has an empty list when the only change is removed lines", () => {
    expect(change("a\nb\nc\n", "a\nc\n")).toEqual({ status: "modified", changed_lines: [], content: "a\nc\n" });
  });

  it("has an empty list when a file becomes empty", () => {
    expect(change("a\nb\n", "")).toEqual({ status: "modified", changed_lines: [], content: "" });
  });

  it("lists every line when an empty file gets text", () => {
    expect(change("", "a\nb\n")).toEqual({ status: "modified", changed_lines: [1, 2], content: "a\nb\n" });
  });

  it("lists the last line when the only change is a final newline added", () => {
    expect(change("a\nb", "a\nb\n")).toEqual({ status: "modified", changed_lines: [2], content: "a\nb\n" });
  });

  it("lists the last line when the only change is the final newline removed", () => {
    expect(change("a\nb\n", "a\nb")).toEqual({ status: "modified", changed_lines: [2], content: "a\nb" });
  });

  it("marks a line whose only change is trailing spaces or a tab", () => {
    expect(change("a\nb\nc\n", "a\nb \nc\n")?.changed_lines).toEqual([2]);
    expect(change("a\nb\nc\n", "a\nb\n\tc\n")?.changed_lines).toEqual([3]);
  });

  it("marks a blank line that is added", () => {
    expect(change("a\nb\n", "a\n\nb\n")?.changed_lines).toEqual([2]);
  });

  it("marks a line that is added at the start", () => {
    expect(change("a\n", "z\na\n")?.changed_lines).toEqual([1]);
  });

  it("marks every changed line of a file that is rewritten", () => {
    expect(change("a\nb\nc\n", "x\ny\nz\n")?.changed_lines).toEqual([1, 2, 3]);
  });

  it("compares lines after the text is normalized, so CRLF in the source never shows as a change", () => {
    const before = normalizeText("a\r\nb\r\n");
    const after = normalizeText("﻿a\nb\n");

    expect(diffSteps([step(1, { "f.txt": before }), step(2, { "f.txt": after })])[1]?.files[0]?.status).toBe("unchanged");
  });

  it("shows a file as changed in every line when it differs by more edits than the limit, and in the right lines when not", () => {
    const old = range(1, 30).map((n) => `old ${n}\n`).join("");
    const next = range(1, 30).map((n) => `new ${n}\n`).join("");
    const run = (maxEditLength: number) =>
      diffSteps([step(1, { "f.txt": `keep\n${old}` }), step(2, { "f.txt": `keep\n${next}` })], maxEditLength)[1]?.files[0]?.changed_lines;

    expect(run(1000)).toEqual(range(2, 31));
    expect(run(5)).toEqual(range(1, 31));
  });
});

describe("order", () => {
  it("sorts files by the full path compared as plain strings, not by the locale", () => {
    const [first] = diffSteps([step(1, { "b.py": "", "B.py": "", "a/z.py": "", "a-b.py": "", "a.py": "", "Z/a.py": "", "é.py": "", "z.py": "" })]);

    expect(first?.files.map((f) => f.path)).toEqual(["B.py", "Z/a.py", "a-b.py", "a.py", "a/z.py", "b.py", "z.py", "é.py"]);
  });

  it("sorts the deleted files in with the others", () => {
    const [, second] = diffSteps([step(1, { "m.py": "", "a.py": "" }), step(2, { "b.py": "", "z.py": "" })]);

    expect(second?.files.map((f) => `${f.path}:${f.status}`)).toEqual(["a.py:deleted", "b.py:added", "m.py:deleted", "z.py:added"]);
  });

  it("puts the steps in number order whatever the order they come in", () => {
    const result = diffSteps([step(3, { "a.py": "3" }), step(1, { "a.py": "1" }), step(2, { "a.py": "2" })]);

    expect(result.map((s) => s.step)).toEqual([1, 2, 3]);
    expect(result.map((s) => s.files[0]?.status)).toEqual(["added", "modified", "modified"]);
  });

  it("gives the same result whatever the order of the files in the input", () => {
    const one = diffSteps([step(1, { "a": "1", "b": "2" }), step(2, { "b": "2", "a": "x" })]);
    const two = diffSteps([step(1, { "b": "2", "a": "1" }), step(2, { "a": "x", "b": "2" })]);

    expect(one).toEqual(two);
  });

  it("writes the keys of every object in order", () => {
    const [first] = diffSteps([step(1, { "a.py": "x" })]);

    expect(Object.keys(first!)).toEqual(["step", "files"]);
    expect(Object.keys(first!.files[0]!)).toEqual(["path", "status", "content", "changed_lines"]);
  });
});
