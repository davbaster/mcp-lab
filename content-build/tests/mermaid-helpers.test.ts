// The helpers that make a failed golden test name the files that differ.

import { describe, expect, it } from "vitest";
import { differences, firstDifference } from "./mermaid-helpers.ts";

const svg = (title: string, body: string) => Buffer.from(`<svg><title id="diagram-title">${title}</title>${body}</svg>`);

describe("firstDifference", () => {
  it("is empty for the same text", () => {
    expect(firstDifference("a\nb", "a\nb")).toBe("");
  });

  it("shows where the texts differ, the line, the lengths, and the text around it from each side (a CRLF shows as \\r)", () => {
    const message = firstDifference('<svg height="308">\n<g/>', '<svg height="320">\r\n<g/>');

    expect(message).toContain("differs at character 14 (line 1)");
    expect(message).toContain("actual has 23 characters, expected 24");
    expect(message).toContain('height=\\"308\\"');
    expect(message).toContain('height=\\"320\\"');
    expect(firstDifference("a\nb", "a\r\nb")).toContain("\\r");
  });

  it("shows a text that is only longer on one side", () => {
    expect(firstDifference("abc", "abcdef")).toContain("differs at character 3");
  });
});

describe("differences", () => {
  it("is empty for the same files", () => {
    const files = new Map([["a.json", Buffer.from("{}")]]);

    expect(differences(files, new Map(files))).toEqual([]);
  });

  it("names the files that are missing, extra, and different", () => {
    const actual = new Map([["a.json", Buffer.from('{"x":1}')], ["extra.json", Buffer.from("{}")]]);
    const expected = new Map([["a.json", Buffer.from('{"x":2}')], ["missing.json", Buffer.from("{}")]]);

    const found = differences(actual, expected);

    expect(found).toHaveLength(3);
    expect(found[0]).toMatch(/^different: a\.json: differs at character 5/);
    expect(found[1]).toBe("missing: missing.json");
    expect(found[2]).toBe("extra: extra.json");
  });

  it("pairs a different SVG, which has another hashed name, with the golden one by its title, and shows where they differ", () => {
    const actual = new Map([["public/diagram-1111111111111111.svg", svg("A graph", '<rect height="19"/>')]]);
    const expected = new Map([["public/diagram-2222222222222222.svg", svg("A graph", '<rect height="20"/>')]]);

    const found = differences(actual, expected);

    expect(found.map((line) => line.split(":")[0])).toEqual(["missing", "extra", "compare public/diagram-1111111111111111.svg with public/diagram-2222222222222222.svg (title \"A graph\")"]);
    expect(found[2]).toContain('height=\\"19\\"');
    expect(found[2]).toContain('height=\\"20\\"');
  });
});
