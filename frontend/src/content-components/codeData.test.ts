import { describe, expect, it } from "vitest";
import golden from "./fixtures/chapter-code.response.json";
import { readChapterCode } from "./codeData";
import { splitLines } from "./codeLines";

/** The answer as loose data, so a test can damage it in ways the types do not allow. */
type Loose = { steps: { step: unknown; files?: Record<string, unknown>[] }[] } & Record<string, unknown>;
const clone = () => structuredClone(golden) as unknown as Loose;

describe("readChapterCode", () => {
  it("reads the golden answer, with the status and changed lines of each file", () => {
    const code = readChapterCode(golden);
    expect(code?.zip).toEqual({ url: "/api/courses/sample-course/chapters/01-first-steps/code.zip", fileName: "01-first-steps.zip" });
    expect(code?.steps.map((step) => step.step)).toEqual([1, 2, 3]);
    const main = code?.steps[1].files.find((file) => file.path === "main.py");
    expect(main).toMatchObject({ status: "modified", changedLines: [2, 4] });
    expect(main?.content).toContain("shout");
  });

  it.each([null, undefined, 1, "x", [], {}, { steps: [] }, { zip: {}, steps: [] }, { zip: { url: "/x", file_name: 1 }, steps: [] }])(
    "rejects %j",
    (value) => {
      expect(readChapterCode(value)).toBeNull();
    },
  );

  it.each([
    ["a step that is not an object", (d: Loose) => ((d.steps as unknown[])[0] = 5)],
    ["a step number that is not whole", (d: Loose) => (d.steps[0].step = 1.5)],
    ["a step without files", (d: Loose) => delete d.steps[0].files],
    ["a file that is not an object", (d: Loose) => ((d.steps[0].files as unknown[])[0] = null)],
    ["a file without a path", (d: Loose) => delete d.steps[0].files![0].path],
    ["a file without content", (d: Loose) => (d.steps[0].files![0].content = null)],
    ["a status that is not one of the four", (d: Loose) => (d.steps[0].files![0].status = "renamed")],
    ["a status that is not a string", (d: Loose) => (d.steps[0].files![0].status = 1)],
    ["changed_lines that is not a list", (d: Loose) => (d.steps[0].files![0].changed_lines = "1,2")],
    ["changed_lines with a text in it", (d: Loose) => (d.steps[0].files![0].changed_lines = [1, "2"])],
    ["changed_lines with a fraction in it", (d: Loose) => (d.steps[0].files![0].changed_lines = [1.5])],
  ])("rejects %s", (_name, damage) => {
    const data = clone();
    damage(data);
    expect(readChapterCode(data)).toBeNull();
  });
});

describe("splitLines", () => {
  it("has no lines for an empty file", () => {
    expect(splitLines("")).toEqual([]);
  });

  it("makes one line of a file with no line break", () => {
    expect(splitLines("abc")).toEqual([{ text: "abc", end: "" }]);
  });

  it("adds no extra last line for a final newline", () => {
    expect(splitLines("a\nb\n")).toEqual([
      { text: "a", end: "\n" },
      { text: "b", end: "\n" },
    ]);
  });

  it("counts a file of one empty line", () => {
    expect(splitLines("\n")).toEqual([{ text: "", end: "\n" }]);
  });

  it("keeps empty lines and a last line without a final newline", () => {
    expect(splitLines("a\n\nb")).toEqual([
      { text: "a", end: "\n" },
      { text: "", end: "\n" },
      { text: "b", end: "" },
    ]);
  });

  it("splits on newlines only, so a lone carriage return stays in its line", () => {
    expect(splitLines("a\rb\n")).toEqual([{ text: "a\rb", end: "\n" }]);
  });

  it("gives back the file when the lines are put together", () => {
    for (const content of ["", "a", "a\n", "\n\n", "a\n\nb\n", "tab\there\r\nx"]) {
      expect(splitLines(content).map((line) => line.text + line.end).join("")).toBe(content);
    }
  });
});
