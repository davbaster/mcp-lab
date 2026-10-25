// The notes about diagrams in the READMEs stay true: the example compiles, the lists match the code, and the policy is the one the backend sends.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileLesson } from "../src/lesson.ts";
import { DIAGRAM_TYPES, diagramSourceProblems } from "../src/diagram-source.ts";
import { PART_DIR } from "./helpers.ts";

const ROOT = join(PART_DIR, "..");
const COURSES_README = readFileSync(join(ROOT, "courses", "README.md"), "utf8");
const README = readFileSync(join(PART_DIR, "README.md"), "utf8");
const ROOT_README = readFileSync(join(ROOT, "README.md"), "utf8");
const BACKEND_ROUTES = readFileSync(join(ROOT, "backend", "app", "asset_routes.py"), "utf8");
const AUTHORING = /^## Diagrams$([\s\S]*?)^## Code steps$/m.exec(COURSES_README)?.[1] ?? "";
const TOOL = /^## Diagrams$([\s\S]*?)^## Building the courses$/m.exec(README)?.[1] ?? "";
const SHORT = /^#### Diagrams$([\s\S]*?)^Write the `ids\.json`/m.exec(ROOT_README)?.[1] ?? "";

describe("courses/README.md", () => {
  it("has a Diagrams section with an example (a piece of a lesson) that compiles, passes the source checks, and uses a quote written as &quot;", () => {
    const example = /^````mdx\n([\s\S]*?)\n````$/m.exec(AUTHORING)?.[1];

    expect(example).toBeDefined();
    const result = compileLesson(`---\ntitle: Example\norder: 1\n---\n\n${example}\n`, { path: "example.mdx" });
    expect(result).toHaveProperty("diagrams");
    const diagrams = "diagrams" in result ? result.diagrams : [];
    expect(diagrams).toHaveLength(1);
    expect(diagramSourceProblems(diagrams[0]?.source ?? "")).toEqual([]);
    expect(diagrams[0]?.source).toContain('{"Passed?"}');
    expect(AUTHORING).toContain("`&quot;`");
  });

  it("says the three things the authors need: quotes, indentation, and the supported types (all of them)", () => {
    expect(AUTHORING).toContain("single quotes");
    expect(AUTHORING).toContain("MDX removes the spaces at the start of every line of the prop");
    for (const type of DIAGRAM_TYPES) expect(AUTHORING, type).toContain(`\`${type}\``);
  });

  it("links the Diagram row to the section of the tool", () => {
    expect(COURSES_README).toMatch(/\| `Diagram` \|[^\n]*\[Diagrams\]\(\.\.\/content-build\/README\.md#diagrams\)/);
  });
});

describe("content-build/README.md", () => {
  it("has the parts the issue asks for", () => {
    for (const heading of ["### What the author may write", "### What the build writes", "### The settings", "### The browser", "### The cache", "### Tests", "### Upgrading Mermaid or Chromium", "### Windows"]) {
      expect(TOOL, heading).toContain(heading);
    }
  });

  it("names every setting of mermaid-config.json, the environment variables, the commands, and both tiers", () => {
    const config = JSON.parse(readFileSync(join(PART_DIR, "mermaid-config.json"), "utf8")) as Record<string, unknown>;
    for (const key of Object.keys(config).filter((name) => name !== "themeVariables")) expect(TOOL, key).toContain(key);
    for (const text of ["`themeVariables`", "MERMAID_NO_SANDBOX=1", "MERMAID_CACHE_DIR", "npm run install:browser", "node tests/update-mermaid-goldens.ts", "deb.deps", "Tier 1", "Tier 2", "--host-resolver-rules=MAP * ~NOTFOUND", "PowerShell 5.1"]) {
      expect(TOOL, text).toContain(text);
    }
    for (const type of DIAGRAM_TYPES) expect(TOOL, type).toContain(`\`${type}\``);
  });

  it("states the limits that the code has", async () => {
    const { MAX_SOURCE_CHARACTERS, MAX_SOURCE_LINES } = await import("../src/diagram-source.ts");

    expect(TOOL).toContain(`${MAX_SOURCE_CHARACTERS} characters`);
    expect(TOOL).toContain(`${MAX_SOURCE_LINES} lines`);
  });
});

describe("README.md", () => {
  it("has a short Diagrams section: quotes, indentation, the types, and the install of the browser", () => {
    expect(SHORT).toContain("`&quot;`");
    expect(SHORT).toContain("MDX removes the spaces at the start of every line of the prop");
    for (const type of DIAGRAM_TYPES) expect(SHORT, type).toContain(`\`${type}\``);
    expect(ROOT_README).toContain("npm run install:browser");
  });

  it("says that the checks are one layer, with the policy that the asset route really sends", () => {
    const policy = /SVG_POLICY = "([^"]+)"/.exec(BACKEND_ROUTES)?.[1];

    expect(policy).toBeDefined();
    expect(SHORT).toContain("one layer");
    expect(SHORT).toContain("`<img>` (#19)");
    expect(SHORT).toContain(`\`Content-Security-Policy: ${policy}\` (#58)`);
  });
});
