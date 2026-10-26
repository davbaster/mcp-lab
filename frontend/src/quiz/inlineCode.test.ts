import { describe, expect, it } from "vitest";
import { splitInlineCode } from "./inlineCode";

describe("splitInlineCode", () => {
  it("returns nothing for an empty string", () => {
    expect(splitInlineCode("")).toEqual([]);
  });

  it("returns plain text as one segment", () => {
    expect(splitInlineCode("Just words")).toEqual([{ code: false, text: "Just words" }]);
  });

  it("turns a backtick span into a code segment", () => {
    expect(splitInlineCode("Use `@mcp.tool()` here")).toEqual([
      { code: false, text: "Use " },
      { code: true, text: "@mcp.tool()" },
      { code: false, text: " here" },
    ]);
  });

  it("handles a span at the start, at the end, and several spans", () => {
    expect(splitInlineCode("`a` and `b`")).toEqual([
      { code: true, text: "a" },
      { code: false, text: " and " },
      { code: true, text: "b" },
    ]);
  });

  it("leaves an unmatched backtick as typed", () => {
    expect(splitInlineCode("a ` b")).toEqual([{ code: false, text: "a ` b" }]);
  });

  it("leaves the third backtick of an odd count as typed", () => {
    expect(splitInlineCode("`a` and ` b")).toEqual([
      { code: true, text: "a" },
      { code: false, text: " and ` b" },
    ]);
  });

  it("leaves an empty pair as typed", () => {
    expect(splitInlineCode("a `` b")).toEqual([{ code: false, text: "a `` b" }]);
    expect(splitInlineCode("``")).toEqual([{ code: false, text: "``" }]);
  });

  it("leaves a run of three backticks as typed", () => {
    expect(splitInlineCode("x ``` y")).toEqual([{ code: false, text: "x ``` y" }]);
  });

  it("still finds a span after an empty pair", () => {
    expect(splitInlineCode("`` then `c`")).toEqual([
      { code: false, text: "`` then " },
      { code: true, text: "c" },
    ]);
  });

  it("keeps whitespace inside a span exactly", () => {
    expect(splitInlineCode("`  a  b `")).toEqual([{ code: true, text: "  a  b " }]);
  });

  it("does not interpret Markdown, HTML or entities", () => {
    const hostile = "'<img src=x onerror=alert(1)>' **bold** &amp; [x](y) _z_";
    expect(splitInlineCode(hostile)).toEqual([{ code: false, text: hostile }]);
  });

  it("keeps markup inside a span as text", () => {
    expect(splitInlineCode("`<b>x</b>`")).toEqual([{ code: true, text: "<b>x</b>" }]);
  });
});
