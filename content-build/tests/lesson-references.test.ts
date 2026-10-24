// compileLesson also returns the asset and media references it found, next to the tree and not inside it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileLesson } from "../src/lesson.ts";
import { serializeTree } from "../src/lesson-tree.ts";
import { LESSON_FIXTURES } from "./helpers.ts";

const HEADER = "---\ntitle: Case\norder: 1\n---\n\n";

function references(body: string, path = "lessons/case.mdx") {
  const result = compileLesson(`${HEADER}${body}\n`, { path });
  if ("problems" in result) throw new Error(`unexpected problems: ${JSON.stringify(result.problems)}`);
  return result;
}

describe("compileLesson references", () => {
  it("lists each reference with its component, prop, value, line, and column, in the order of the text", () => {
    const lines = [
      "![A photo](images/photo.jpg) and a [link](images/not-a-reference.png)",
      '<Image src="images/pic.png" alt="A picture" />',
      '<Diagram alt="A diagram" src="diagrams/flow.svg" />',
      '<Model3D src="models/server.glb" alt="A server" poster="images/banner.webp" />',
      '<Video src="https://media.mcp-lab.example/a.mp4" title="A video" captions="captions/c.vtt" poster="images/p.png" />',
      '<CodeSteps step="2" file="server.py" />',
      '<Diagram alt="Mermaid" source="graph TD; A-->B" />',
    ];
    const { references: found } = references(lines.join("\n\n"));
    // Line 6 is the first line of the body; the others follow with a blank line between. A column is where the text is, plus one.
    const at = (index: number, needle: string) => ({ line: 6 + index * 2, column: (lines[index] ?? "").indexOf(needle) + 1 });

    expect(found).toEqual([
      { component: "Markdown", prop: "image", value: "images/photo.jpg", ...at(0, "![A photo]") },
      { component: "Image", prop: "src", value: "images/pic.png", ...at(1, "src=") },
      { component: "Diagram", prop: "src", value: "diagrams/flow.svg", ...at(2, "src=") },
      { component: "Model3D", prop: "src", value: "models/server.glb", ...at(3, "src=") },
      { component: "Model3D", prop: "poster", value: "images/banner.webp", ...at(3, "poster=") },
      { component: "Video", prop: "src", value: "https://media.mcp-lab.example/a.mp4", ...at(4, "src=") },
      { component: "Video", prop: "captions", value: "captions/c.vtt", ...at(4, "captions=") },
      { component: "Video", prop: "poster", value: "images/p.png", ...at(4, "poster=") },
    ]);
    expect(found.map((reference) => reference.column)).toEqual([1, 8, 26, 10, 49, 8, 66, 92]);
  });

  it("finds the references inside nested components, lists, block quotes, and emphasis", () => {
    const { references: found } = references(
      [
        '<Callout type="note" title="T">\n\n![in a callout](a.png)\n\n* item ![in a list](b.png)\n\n> *quoted ![in a quote](c.png)*\n\n</Callout>',
        '<Tabs>\n\n<Tab label="One">\n\n<Image src="d.png" alt="A" />\n\n</Tab>\n\n<Tab label="Two">\n\nText\n\n</Tab>\n\n</Tabs>',
      ].join("\n\n"),
    );

    expect(found.map((reference) => reference.value)).toEqual(["a.png", "b.png", "c.png", "d.png"]);
  });

  it("keeps the references out of the tree, whose golden files do not change", () => {
    const result = references('<Image src="images/pic.png" alt="A picture" />\n\n![A](images/photo.jpg)');

    expect(Object.keys(result).sort()).toEqual(["codeSteps", "references", "tree"]);
    expect(serializeTree(result.tree)).not.toContain("column");
    expect(serializeTree(result.tree)).not.toContain("references");
    for (const name of ["components", "markdown"]) {
      const source = readFileSync(join(LESSON_FIXTURES, "valid", `${name}.mdx`), "utf8");
      const golden = readFileSync(join(LESSON_FIXTURES, "valid", `${name}.json`), "utf8");
      const compiled = compileLesson(source, { path: `${name}.mdx` });

      expect("tree" in compiled && serializeTree(compiled.tree)).toBe(golden);
    }
  });

  it("gives the same positions for CRLF and LF text", () => {
    const body = '<Image src="images/pic.png" alt="A picture" />\n\n![A](images/photo.jpg)';
    const lf = compileLesson(`${HEADER}${body}\n`, { path: "a.mdx" });
    const crlf = compileLesson(`${HEADER}${body}\n`.replaceAll("\n", "\r\n"), { path: "a.mdx" });

    expect(crlf).toEqual(lf);
  });

  it("returns no references with the problems of a lesson that does not compile", () => {
    const result = compileLesson(`${HEADER}<Image src="a.png" alt="A" />\n\n{1 + 1}\n`, { path: "a.mdx" });

    expect(Object.keys(result)).toEqual(["problems"]);
  });

  it("returns an empty list for a lesson with none", () => {
    expect(references("Just text.").references).toEqual([]);
  });

  it("returns the value as the author wrote it, not decoded or trimmed", () => {
    const { references: found } = references('<Image src="images/pic.png" alt="A picture" />\n\n![A](images/a%20b.png)');

    expect(found.map((reference) => reference.value)).toEqual(["images/pic.png", "images/a%20b.png"]);
  });
});
