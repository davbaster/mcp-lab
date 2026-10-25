// What the build does to a rendered SVG: the size, the accessible name, and that the SVG rules still apply to the result.

import { describe, expect, it } from "vitest";
import { escapeText, finishSvg, labelSvg } from "../src/diagram-svg.ts";
import { svgProblems } from "../src/svg.ts";
import { fakeSvg } from "./mermaid-helpers.ts";

const MERMAID_ROOT = '<svg id="diagram" width="100%" xmlns="http://www.w3.org/2000/svg" viewBox="4 4 196.5 243" style="max-width: 196.5px;" role="graphics-document document" aria-roledescription="flowchart-v2">';

function done(svg: string): string {
  const result = finishSvg(svg);
  if ("problem" in result) throw new Error(result.problem);
  return result.svg;
}

describe("finishSvg", () => {
  it("gives the root a numeric width and height equal to the size of the viewBox, replacing 100%", () => {
    const svg = done(`${MERMAID_ROOT}<g/></svg>`);

    expect(svg).toMatch(/^<svg [^>]*\swidth="196.5"/);
    expect(svg).toMatch(/^<svg [^>]*\sheight="243"/);
    expect(svg).not.toContain("100%");
    expect(svg).toContain('viewBox="4 4 196.5 243"');
  });

  it("changes nothing else, and is idempotent", () => {
    const once = done(`${MERMAID_ROOT}<g id="x"/></svg>`);

    expect(once.slice(once.indexOf("<g"))).toBe('<g id="x"/></svg>');
    expect(done(once)).toBe(once);
  });

  it.each(["<g/>", '<svg width="3">', '<svg viewBox="0 0 0 5">', '<svg viewBox="a b c d">', '<svg viewBox="0 0 5">'])("reports %s as a problem and does not repair it", (text) => {
    expect(finishSvg(text)).toEqual({ problem: expect.any(String) });
  });
});

describe("labelSvg", () => {
  const base = done(`${MERMAID_ROOT}<style>#diagram{}</style><g/></svg>`);

  it("adds a title with the alt text as the first child, role=img, and aria-labelledby that names the title", () => {
    const svg = labelSvg(base, "A flow");

    expect(svg).toMatch(/^<svg [^>]*\srole="img"/);
    expect(svg).not.toContain("graphics-document");
    expect(svg).toMatch(/^<svg [^>]*\saria-labelledby="diagram-title"[^>]*><title id="diagram-title">A flow<\/title><style>/);
  });

  it("escapes the alt text: no raw tag gets into the output, and the SVG still passes the rules", () => {
    const svg = labelSvg(base, 'Tom & "Jerry" <b>');

    expect(svg).toContain('<title id="diagram-title">Tom &amp; "Jerry" &lt;b&gt;</title>');
    expect(svg).not.toContain("<b>");
    expect(svgProblems(svg)).toEqual([]);
  });

  it("escapes markup that tries to close the title, start a script, or add an attribute", () => {
    const svg = labelSvg(base, '</title><script>alert(1)</script><svg onload="x">');

    expect(svg).not.toContain("<script");
    expect(svg.match(/<\/title>/g)).toHaveLength(1);
    expect(svgProblems(svg)).toEqual([]);
    expect(svg.match(/<title\b/g)).toHaveLength(1);
  });

  it("does not let alt text that looks like an attribute (one = 1, or onload=) fail the SVG rules, and keeps the same text", () => {
    const svg = labelSvg(base, 'Step one = start, then onload="x" href=y');

    expect(svgProblems(svg)).toEqual([]);
    expect(svg).toContain("Step one &#61; start");
  });

  it("replaces Mermaid's own title and keeps its description", () => {
    const withMermaidTitle = done(`${MERMAID_ROOT}<title id="chart-title-diagram">Mermaid title</title><desc id="chart-desc-diagram">The description</desc><g/></svg>`);

    const svg = labelSvg(withMermaidTitle, "Alt");

    expect(svg).not.toContain("Mermaid title");
    expect(svg.match(/<title\b/g)).toHaveLength(1);
    expect(svg).toContain('<desc id="chart-desc-diagram">The description</desc>');
  });

  it("turns a character that XML cannot hold into U+FFFD, so the file is still well-formed", () => {
    expect(escapeText("a\u0001b\u0000c￾d\tok\nline")).toBe("a�b�c�d\tok\nline");
    expect(labelSvg(base, "x\u0000y")).not.toContain("\u0000");
  });

  it("is the only thing that depends on alt: the same drawing with other alt text differs only in the title", () => {
    const [one, two] = [labelSvg(base, "One"), labelSvg(base, "Two")];

    expect(one).not.toBe(two);
    expect(one.replace("One", "Two")).toBe(two);
  });

  it("is deterministic", () => {
    expect(labelSvg(base, "Same")).toBe(labelSvg(base, "Same"));
  });

  it("works on the fake renderer's output too", () => {
    expect(svgProblems(labelSvg(done(fakeSvg("x")), "alt"))).toEqual([]);
  });
});
