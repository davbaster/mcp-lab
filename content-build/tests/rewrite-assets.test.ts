// rewriteAssetUrls: asset references in a compiled lesson become the URLs of the hashed files.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { REFERENCE_PROPS } from "../src/assets.ts";
import { compileLesson } from "../src/lesson.ts";
import { serializeTree, treeErrors } from "../src/lesson-tree.ts";
import type { LessonTree } from "../src/lesson-tree.ts";
import { rewriteAssetUrls } from "../src/rewrite-assets.ts";
import { FIXTURES, PART_DIR, VALID_COURSE } from "./helpers.ts";

const MAP: Record<string, { file: string }> = JSON.parse(readFileSync(join(FIXTURES, "expected", "assets-map", "sample-course.json"), "utf8")).files;
const url = (path: string) => `/api/courses/sample-course/assets/${MAP[path]?.file}`;
const LESSON = readFileSync(join(FIXTURES, "lessons", "assets", "all-assets.mdx"), "utf8");

function compile(source: string): LessonTree {
  const result = compileLesson(source, { path: "lessons/case.mdx" });
  if ("problems" in result) throw new Error(`unexpected problems: ${JSON.stringify(result.problems)}`);
  return result.tree;
}

const withBody = (body: string) => compile(`---\ntitle: Case\norder: 1\n---\n\n${body}\n`);

/** Freezes a tree and everything in it, so that a function that changes it throws. */
function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("the golden test: a lesson with all seven components and every asset prop", () => {
  it("uses all seven components, every asset prop, and a Markdown image", () => {
    const names = new Set([...LESSON.matchAll(/<([A-Z][A-Za-z0-9]*)/g)].map((match) => match[1]));

    expect([...names].sort()).toEqual(["Callout", "CodeSteps", "Diagram", "Image", "Model3D", "Tab", "Tabs", "Video"]);
    for (const [component, props] of Object.entries(REFERENCE_PROPS)) {
      for (const prop of Object.keys(props)) expect(LESSON, `${component}.${prop}`).toMatch(new RegExp(`<${component}[^>]*\\b${prop}=`));
    }
    expect(LESSON).toMatch(/!\[[^\]]*\]\(images\/photo\.jpg/);
  });

  it("is rewritten to exactly the committed golden tree", () => {
    const rewritten = rewriteAssetUrls(compile(LESSON), "sample-course", MAP);
    const golden = readFileSync(join(FIXTURES, "expected", "lessons", "all-assets.json"));

    expect(Buffer.from(serializeTree(rewritten), "utf8").equals(golden)).toBe(true);
  });

  it("covers each prop: Image.src, Diagram.src, Model3D.src, Model3D.poster, Video.poster, Video.captions, and a Markdown image", () => {
    const text = JSON.stringify(rewriteAssetUrls(compile(LESSON), "sample-course", MAP));

    for (const path of ["images/pic.png", "diagrams/flow.svg", "models/server.glb", "images/banner.webp", "captions/intro.vtt", "images/photo.jpg", "images/logo.svg", "models/box.gltf"]) {
      expect(text, path).toContain(url(path));
    }
    expect(text).not.toMatch(/"(?:src|poster|captions)":"(?:images|diagrams|models|captions)\//);
    expect(text).not.toMatch(/"type":"image","url":"images\//);
  });

  it("leaves the URLs of allowlisted Video props and Video.src, Markdown links, CodeSteps, and Mermaid source alone", () => {
    const text = JSON.stringify(rewriteAssetUrls(compile(LESSON), "sample-course", MAP));

    expect(text).toContain('"src":"https://media.mcp-lab.example/videos/intro.mp4"');
    expect(text).toContain('"src":"https://www.youtube-nocookie.com/embed/abc"');
    expect(text).toContain('"captions":"https://media.mcp-lab.example/c.vtt"');
    expect(text).toContain('"poster":"https://media.mcp-lab.example/p.png"');
    expect(text).toContain('"url":"images/pic.png"'); // the link, not the image
    expect(text).toContain('"file":"server.py"');
    expect(text).toContain('"source":"graph TD; A-->B"');
  });

  it("validates against lesson-tree.schema.json, with the tree schema compiled apart from the code", () => {
    const check = new Ajv({ allErrors: true, strict: true }).compile(JSON.parse(readFileSync(join(PART_DIR, "schemas", "lesson-tree.schema.json"), "utf8")));
    const rewritten = rewriteAssetUrls(compile(LESSON), "sample-course", MAP);

    expect(check(rewritten), JSON.stringify(check.errors)).toBe(true);
    expect(treeErrors(rewritten)).toEqual([]);
  });
});

describe("rewriteAssetUrls", () => {
  it("does not change the input tree, and returns a new one", () => {
    const tree = freeze(compile(LESSON));
    const before = JSON.stringify(tree);

    const rewritten = rewriteAssetUrls(tree, "sample-course", MAP);

    expect(JSON.stringify(tree)).toBe(before);
    expect(rewritten).not.toBe(tree);
    expect(rewritten).not.toEqual(tree);
  });

  it("does not share objects with the input, so changing the result cannot change the input", () => {
    const tree = compile(LESSON);
    const before = JSON.stringify(tree);
    const rewritten = rewriteAssetUrls(tree, "sample-course", MAP);

    const stack: unknown[] = [rewritten];
    while (stack.length > 0) {
      const value = stack.pop();
      if (typeof value === "object" && value !== null) {
        Object.assign(value, { touched: true });
        stack.push(...Object.values(value));
      }
    }
    expect(JSON.stringify(tree)).toBe(before);
  });

  it("returns an equal tree for a lesson with no asset reference", () => {
    const tree = withBody("# Title\n\nSome **text**, a [link](images/pic.png), and `code`.\n\n```python\nprint(1)\n```\n\n* one\n* two\n\n> quote\n\n---");

    expect(rewriteAssetUrls(tree, "sample-course", {})).toEqual(tree);
  });

  it("uses the course ID it is given in the URL", () => {
    const tree = withBody("![A](images/pic.png)");
    const rewritten = JSON.stringify(rewriteAssetUrls(tree, "another-course", MAP));

    expect(rewritten).toContain(`/api/courses/another-course/assets/${MAP["images/pic.png"]?.file}`);
  });

  it("rewrites a Markdown image inside emphasis, strong text, a link, a list, and a block quote", () => {
    const tree = withBody(
      "*![a](images/pic.png)* **![b](images/pic.png)** [![c](images/pic.png)](https://example.com/)\n\n* ![d](images/pic.png)\n\n> ![e](images/pic.png)\n\n1. ![f](images/pic.png)",
    );

    const text = JSON.stringify(rewriteAssetUrls(tree, "sample-course", MAP));

    expect(text.split(url("images/pic.png")).length - 1).toBe(6);
    expect(text).not.toContain('"url":"images/pic.png"');
    expect(text).toContain('"url":"https://example.com/"');
  });

  it("keeps the title and alt of a Markdown image", () => {
    const rewritten = rewriteAssetUrls(withBody('![An alt](images/pic.png "A title")'), "sample-course", MAP);

    expect(JSON.stringify(rewritten)).toContain(`"type":"image","url":"${url("images/pic.png")}","alt":"An alt","title":"A title"`);
  });

  it("throws an internal error for a reference that is not in the map, naming the path", () => {
    expect(() => rewriteAssetUrls(withBody("![A](images/missing.png)"), "sample-course", MAP)).toThrow(/^internal error: the asset `images\/missing\.png` is not in the asset map/);
    expect(() => rewriteAssetUrls(withBody('<Image src="images/missing.png" alt="A" />'), "sample-course", MAP)).toThrow(/internal error/);
    expect(() => rewriteAssetUrls(withBody('<Model3D src="models/server.glb" alt="A" poster="images/missing.png" />'), "sample-course", MAP)).toThrow(/images\/missing\.png/);
  });

  it("does not take a map entry from the prototype of the map", () => {
    for (const path of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(() => rewriteAssetUrls(withBody(`![A](${path})`), "sample-course", {}), path).toThrow(/internal error/);
    }
  });

  it("rewrites every prop of the table that the checks use, so the two cannot differ", () => {
    for (const [component, props] of Object.entries(REFERENCE_PROPS)) {
      for (const [prop, rule] of Object.entries(props)) {
        const node = { type: "component" as const, name: component, props: { [prop]: "images/pic.png" }, children: [] };
        const rewritten = rewriteAssetUrls({ type: "root", children: [node] }, "sample-course", MAP);
        const value = (rewritten.children[0] as typeof node).props[prop];

        expect(value, `${component}.${prop}`).toBe(rule.kind === "video" ? "images/pic.png" : url("images/pic.png"));
      }
    }
  });

  it("does not change a prop that has a scheme, even for an asset prop", () => {
    const tree: LessonTree = {
      type: "root",
      children: [{ type: "component", name: "Video", props: { poster: "https://media.mcp-lab.example/p.png", captions: "https://media.mcp-lab.example/c.vtt" }, children: [] }],
    };

    expect(rewriteAssetUrls(tree, "sample-course", {})).toEqual(tree);
  });

  it("does not change a bare attribute (true) or a prop of a component that has no asset props", () => {
    const tree: LessonTree = {
      type: "root",
      children: [
        { type: "component", name: "Callout", props: { type: "note", src: "images/pic.png" }, children: [] },
        { type: "component", name: "Image", props: { alt: "images/pic.png", src: true }, children: [] },
      ],
    };

    expect(rewriteAssetUrls(tree, "sample-course", {})).toEqual(tree);
  });

  it("rewrites the references of the lesson of the valid course to files that exist in the golden output", () => {
    const text = readFileSync(join(VALID_COURSE, "chapters", "02-going-further", "lessons", "01-next.mdx"), "utf8");
    const rewritten = JSON.stringify(rewriteAssetUrls(compile(text), "sample-course", MAP));
    const urls = [...rewritten.matchAll(/\/api\/courses\/sample-course\/assets\/([^"]+)"/g)].map((match) => match[1]);

    expect(urls.length).toBe(10);
    for (const file of urls) expect(readFileSync(join(FIXTURES, "expected", "public", "assets", "sample-course", file ?? "")).length).toBeGreaterThan(0);
  });
});
