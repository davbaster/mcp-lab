// The examples and the notes in the READMEs stay true.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileLesson } from "../src/lesson.ts";
import { PART_DIR } from "./helpers.ts";

const COURSES_README = readFileSync(join(PART_DIR, "..", "courses", "README.md"), "utf8");
const README = readFileSync(join(PART_DIR, "README.md"), "utf8");

describe("courses/README.md", () => {
  it("has a Lessons section", () => {
    expect(COURSES_README).toMatch(/^## Lessons$/m);
    expect(COURSES_README).toContain("**You may write**");
    expect(COURSES_README).toContain("**You may not write**");
  });

  it("holds an example lesson that compiles, and uses every component of the table", () => {
    const example = /^````mdx\n([\s\S]*?)\n````$/m.exec(COURSES_README)?.[1];

    expect(example).toBeDefined();
    const result = compileLesson(`${example}\n`, { path: "example.mdx" });
    expect(result).toHaveProperty("tree");
    for (const name of ["Callout", "Tabs", "Tab", "Image", "CodeSteps"]) expect(example).toContain(`<${name}`);
  });

  it("lists every component with its props", () => {
    for (const row of ["`Video`", "`Model3D`", "`Diagram`", "`Image`", "`Callout`", "`Tabs`", "`Tab` (only inside `Tabs`)", "`CodeSteps`"]) {
      expect(COURSES_README).toContain(`| ${row} |`);
    }
  });
});

describe("content-build/README.md", () => {
  it("documents the compile command, the tree format, the schemas, the annotations, and how to add a component", () => {
    for (const text of [
      "npm run compile -- <lesson.mdx>",
      "### The tree",
      "### Component schemas",
      "frontend/src/content-components/schemas/",
      '"x-kind": "url"',
      '"x-children"',
      '"x-nested"',
      "To add a component",
      "### Setup errors",
    ]) {
      expect(README, text).toContain(text);
    }
  });

  it("warns that Windows PowerShell 5.1 writes > redirects as UTF-16", () => {
    expect(README).toMatch(/PowerShell 5\.1.*UTF-16/);
    expect(README).toContain("not valid input for anything else");
  });
});
