import { describe, expect, it } from "vitest";
import { changeSummary, chooseFile, fileLabel, markedLines } from "./codeChanges";
import type { CodeFile } from "./codeData";

const file = (path: string, status: CodeFile["status"], changedLines: number[] = []): CodeFile => ({ path, status, content: "", changedLines });

describe("changeSummary", () => {
  const files = (modified: number, added: number, deleted: number, unchanged = 0) => [
    ...Array.from({ length: modified }, (_, i) => file(`m${i}`, "modified")),
    ...Array.from({ length: added }, (_, i) => file(`a${i}`, "added")),
    ...Array.from({ length: deleted }, (_, i) => file(`d${i}`, "deleted")),
    ...Array.from({ length: unchanged }, (_, i) => file(`u${i}`, "unchanged")),
  ];

  it.each([
    [files(2, 1, 1), "2 files changed, 1 added, 1 deleted"],
    [files(1, 0, 0), "1 file changed"],
    [files(0, 3, 1), "3 files added, 1 deleted"],
    [files(0, 0, 1), "1 file deleted"],
    [files(1, 1, 1), "1 file changed, 1 added, 1 deleted"],
    [files(0, 1, 0), "1 file added"],
    [files(1, 0, 2), "1 file changed, 2 deleted"],
    [files(0, 2, 0, 3), "2 files added"],
  ])("reads %j", (list, expected) => {
    expect(changeSummary(list)).toBe(expected);
  });

  it("is null when no file counts", () => {
    expect(changeSummary([])).toBeNull();
    expect(changeSummary(files(0, 0, 0, 2))).toBeNull();
  });
});

describe("markedLines", () => {
  const marks = (status: CodeFile["status"], lines: number[], count: number, first = false) => [...markedLines(file("f", status, lines), count, first)];

  it("marks the changed lines of an added or modified file", () => {
    expect(marks("modified", [2, 4], 5)).toEqual([2, 4]);
    expect(marks("added", [1, 2, 3], 3)).toEqual([1, 2, 3]);
  });

  it("marks nothing on the first step, whatever the data says", () => {
    expect(marks("added", [1, 2, 3], 3, true)).toEqual([]);
  });

  it("marks nothing in an unchanged or deleted file", () => {
    expect(marks("unchanged", [1, 2], 2)).toEqual([]);
    expect(marks("deleted", [1], 1)).toEqual([]);
  });

  it("ignores a number past the last line, a repeat, one out of order, zero, a negative and a fraction", () => {
    expect(marks("modified", [1, 1, 2, 9], 3)).toEqual([1, 2]);
    expect(marks("modified", [3, 1, 2], 3)).toEqual([3]);
    expect(marks("modified", [0, -1, 1.5, 2], 3)).toEqual([2]);
    expect(marks("modified", [1], 0)).toEqual([]);
  });
});

describe("chooseFile", () => {
  const list = [file("a", "deleted"), file("b", "unchanged"), file("c", "modified"), file("d", "added")];

  it("keeps the preferred file when it is there and not deleted", () => {
    expect(chooseFile(list, "b")).toBe("b");
    expect(chooseFile(list, "d")).toBe("d");
  });

  it("takes the first added or modified file for a preferred file that is deleted, missing or not given", () => {
    expect(chooseFile(list, "a")).toBe("c");
    expect(chooseFile(list, "gone")).toBe("c");
    expect(chooseFile(list, null)).toBe("c");
  });

  it("takes the first file that is not deleted when none is added or modified, and the first file when all are deleted", () => {
    expect(chooseFile([file("a", "deleted"), file("b", "unchanged")], null)).toBe("b");
    expect(chooseFile([file("a", "deleted"), file("b", "deleted")], null)).toBe("a");
    expect(chooseFile([], "a")).toBeNull();
  });

  it("treats paths that are names of Object.prototype as plain values", () => {
    expect(chooseFile([file("__proto__", "unchanged"), file("constructor", "modified")], "__proto__")).toBe("__proto__");
    expect(chooseFile([file("toString", "unchanged")], "hasOwnProperty")).toBe("toString");
  });
});

describe("fileLabel", () => {
  it("has a word for added, modified and deleted, and none for unchanged", () => {
    expect(["added", "modified", "deleted", "unchanged"].map((status) => fileLabel(status as CodeFile["status"]))).toEqual(["New", "Changed", "Deleted", null]);
  });
});
