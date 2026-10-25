// The golden output of the Mermaid fixture (`fixtures/expected-mermaid/`): what is in it, that it is safe, and (tier 2) that the real
// build of the fixture gives exactly these bytes, also from another working folder. Regenerate it as README.md says.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { treeErrors } from "../src/lesson-tree.ts";
import type { LessonTree } from "../src/lesson-tree.ts";
import { svgProblems } from "../src/svg.ts";
import { filesOf, newBuildFolder, runBuild, snapshotOf } from "./build-support.ts";
import { PART_DIR, SLOW_PROCESS_TIMEOUT_MS, temporaryFolder } from "./helpers.ts";
import { BROWSER_TEST_TIMEOUT_MS, MERMAID_COURSES, MERMAID_GOLDEN } from "./mermaid-helpers.ts";

const BUILD_GOLDEN = join(MERMAID_GOLDEN, "build");
const TYPES = ["classDiagram", "erDiagram", "flowchart", "graph", "pie", "sequenceDiagram", "stateDiagram", "stateDiagram-v2"];

/** Every golden SVG: the renderer's output for each type (as Mermaid wrote it), and the files of the golden build (as the build writes them). */
function goldenSvgs(): [string, string][] {
  return [...filesOf(MERMAID_GOLDEN)].filter(([path]) => path.endsWith(".svg")).map(([path, bytes]) => [path, bytes.toString("utf8")]);
}

describe("what the golden folder holds", () => {
  it("has the renderer's SVG of each of the eight types, and the golden build folder", () => {
    const paths = [...filesOf(MERMAID_GOLDEN).keys()];

    expect(paths.filter((path) => path.startsWith("renderer/")).sort()).toEqual(TYPES.map((type) => `renderer/${type}.svg`).sort());
    expect(paths).toContain("build/assets-map/mermaid-course.json");
    expect(paths).toContain("build/private/lessons/mermaid-course/01-types.json");
    expect(paths).toContain("build/private/lessons/mermaid-course/01-repeats.json");
    expect(paths.filter((path) => /^build\/public\/assets\/mermaid-course\/diagram-[0-9a-f]{16}\.svg$/.test(path))).toHaveLength(10);
  });

  it("has lesson trees that validate against the lesson tree schema, with { alt, src } on every Diagram", () => {
    for (const id of ["01-types", "01-repeats"]) {
      const tree = (JSON.parse(readFileSync(join(BUILD_GOLDEN, "private", "lessons", "mermaid-course", `${id}.json`), "utf8")) as { tree: LessonTree }).tree;
      const diagrams = tree.children.flatMap((node) => (node.type === "component" && node.name === "Diagram" ? [node] : []));

      expect(treeErrors(tree), id).toEqual([]);
      expect(diagrams.length).toBeGreaterThan(0);
      for (const node of diagrams) expect(Object.keys(node.props), id).toEqual(["alt", "src"]);
    }
  });

  it("holds the Mermaid text nowhere: the comment line of the source is in no golden file", () => {
    for (const [path, bytes] of filesOf(MERMAID_GOLDEN)) {
      expect(bytes.toString("utf8"), path).not.toContain("SENTINEL");
      expect(bytes.toString("utf8"), path).not.toContain('"source"');
    }
  });
});

describe("the golden SVGs are safe", () => {
  it("has golden SVGs to check", () => {
    expect(goldenSvgs()).toHaveLength(18);
  });

  it.each(goldenSvgs())("%s passes svgProblems and has no data:, @font-face, @import, foreignObject, <script, href that is not #..., or on* attribute", (_path, svg) => {
    expect(svgProblems(svg)).toEqual([]);
    expect(svg).not.toMatch(/data:/i);
    expect(svg).not.toMatch(/@font-face/i);
    expect(svg).not.toMatch(/@import/i);
    expect(svg).not.toMatch(/foreignObject/i);
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/\bhref\s*=\s*["']?(?!#)/i);
    expect(svg).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it.each(goldenSvgs())("%s has no absolute path, date, or random id, and uses the font list of the config", (_path, svg) => {
    expect(svg).not.toMatch(/\/tmp|\/home\/|[A-Za-z]:\\|file:|\b(?:19|20)\d\d-\d\d-\d\d\b/);
    expect(svg).toContain('font-family:"Recursive Variable",system-ui');
  });

  it("gives every build SVG a numeric width and height equal to its viewBox, an id, a role, and the alt text as its first child", () => {
    const built = goldenSvgs().filter(([path]) => path.startsWith("build/"));

    expect(built).toHaveLength(10);
    for (const [path, svg] of built) {
      const root = /^<svg\b[^>]*>/.exec(svg)?.[0] ?? "";
      const box = /\sviewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/.exec(root);
      expect(root, path).toContain(` width="${box?.[1]}"`);
      expect(root, path).toContain(` height="${box?.[2]}"`);
      expect(root, path).toContain(' role="img"');
      expect(root, path).toContain(' aria-labelledby="diagram-title"');
      expect(svg.slice(root.length), path).toMatch(/^<title id="diagram-title">[^<]+<\/title>/);
    }
  });
});

describe("the real build of the fixture gives the golden bytes (tier 2)", () => {
  it("writes exactly the files of fixtures/expected-mermaid/build, byte for byte, with an empty cache", async () => {
    const build = newBuildFolder();

    const { code, stderr } = await runBuild([MERMAID_COURSES, build], { cacheDir: join(temporaryFolder(), "cache") });

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(snapshotOf(build)).toEqual(snapshotOf(BUILD_GOLDEN));
  }, BROWSER_TEST_TIMEOUT_MS);

  it("gives byte-identical files from two working folders, into two build folders, with two caches, and a warm cache gives the same bytes again", () => {
    const run = (cache: string) => {
      const build = newBuildFolder();
      const result = spawnSync(process.execPath, [join(PART_DIR, "src", "build.ts"), MERMAID_COURSES, build], {
        cwd: temporaryFolder(),
        encoding: "utf8",
        env: { ...process.env, MERMAID_CACHE_DIR: cache },
      });
      return { build, ...result };
    };
    const cache = join(temporaryFolder(), "cache");

    const [one, two] = [run(cache), run(join(temporaryFolder(), "cache"))];
    const warm = run(cache);

    for (const result of [one, two, warm]) {
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }
    expect(snapshotOf(one.build)).toEqual(snapshotOf(two.build));
    expect(snapshotOf(warm.build)).toEqual(snapshotOf(one.build));
    expect(snapshotOf(one.build)).toEqual(snapshotOf(BUILD_GOLDEN));
  }, BROWSER_TEST_TIMEOUT_MS + 2 * SLOW_PROCESS_TIMEOUT_MS);
});
