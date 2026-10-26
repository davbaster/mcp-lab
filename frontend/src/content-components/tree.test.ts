import { describe, expect, it } from "vitest";
import { isLessonTree, textOf } from "./tree";

describe("isLessonTree", () => {
  it("accepts a root with children, and an empty one", () => {
    expect(isLessonTree({ type: "root", children: [{ type: "paragraph", children: [] }] })).toBe(true);
    expect(isLessonTree({ type: "root", children: [] })).toBe(true);
  });

  it.each([
    ["null", null],
    ["a string", "root"],
    ["an array", []],
    ["a number", 3],
    ["no type", { children: [] }],
    ["another type", { type: "paragraph", children: [] }],
    ["no children", { type: "root" }],
    ["children that is not a list", { type: "root", children: {} }],
    ["a child that is a string", { type: "root", children: ["x"] }],
    ["a child that is null", { type: "root", children: [null] }],
    ["a child that is a list", { type: "root", children: [[]] }],
  ])("rejects %s", (_name, value) => {
    expect(isLessonTree(value)).toBe(false);
  });
});

describe("textOf", () => {
  it("joins the text and inline code of a node and its descendants", () => {
    const node = {
      type: "heading",
      children: [
        { type: "text", value: "A " },
        { type: "strong", children: [{ type: "text", value: "bold " }, { type: "inlineCode", value: "code" }] },
        { type: "break" },
        { type: "text", value: " end" },
      ],
    };
    expect(textOf(node)).toBe("A bold code end");
  });

  it("ignores values that are not strings, and nodes that are not objects", () => {
    expect(textOf({ type: "text", value: 4, children: [null, "x", { type: "text", value: "ok" }] })).toBe("ok");
  });

  it("handles a very deep tree", () => {
    let node: unknown = { type: "text", value: "deep" };
    for (let i = 0; i < 20000; i += 1) node = { type: "emphasis", children: [node] };
    expect(textOf(node)).toBe("deep");
  });
});
