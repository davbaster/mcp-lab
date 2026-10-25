// `build` with diagrams, with a fake renderer (tier 1: no Chromium): where the files go, the map, the errors, the cache, and the all-or-nothing rule.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DiagramRenderError } from "../src/mermaid-render.ts";
import { treeErrors } from "../src/lesson-tree.ts";
import type { LessonTree } from "../src/lesson-tree.ts";
import { FIXTURES, PART_DIR, SLOW_PROCESS_TIMEOUT_MS, temporaryFolder } from "./helpers.ts";
import { VALID_COURSES, filesOf, newBuildFolder, runBuild, snapshotOf } from "./build-support.ts";
import { fakeRenderer, fakeSvg, forbiddenRenderer, lesson, mermaidCourses } from "./mermaid-helpers.ts";
import type { FakeRenderer } from "./mermaid-helpers.ts";

/** The names the backend accepts at startup for a file of the build (backend/app, #58). */
const BACKEND_FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*-[0-9a-f]{16}\.svg$/;
const LESSONS = join("private", "lessons", "mermaid-course");
const TYPES = "chapters/01-diagram-types/lessons/01-types.mdx";
const REPEATS = "chapters/02-more-diagrams/lessons/01-repeats.mdx";

type Built = { build: string; cache: string; code: number; stdout: string; stderr: string; renderer: FakeRenderer };

/** Builds the Mermaid fixture (or `courses`) with a fake renderer and a cache folder of its own. */
async function buildWith(options: { courses?: string; cache?: string; renderer?: FakeRenderer; build?: string; extra?: Parameters<typeof runBuild>[1] } = {}): Promise<Built> {
  const renderer = options.renderer ?? fakeRenderer();
  const build = options.build ?? newBuildFolder();
  const cache = options.cache ?? join(temporaryFolder(), "cache");
  const result = await runBuild([options.courses ?? mermaidCourses(), build], { rendererFactory: renderer.factory, cacheDir: cache, ...options.extra });
  return { build, cache, renderer, ...result };
}

const lessonJson = (build: string, id: string) => JSON.parse(readFileSync(join(build, LESSONS, `${id}.json`), "utf8")) as { tree: LessonTree };
const assetMap = (build: string) => JSON.parse(readFileSync(join(build, "assets-map", "mermaid-course.json"), "utf8")) as { files: Record<string, { file: string; sha256: string; size: number }> };
const svgFiles = (build: string) => readdirSync(join(build, "public", "assets", "mermaid-course")).sort();

/** The Diagram nodes of a tree, in order. */
function diagramNodes(tree: LessonTree) {
  return tree.children.flatMap((node) => (node.type === "component" && node.name === "Diagram" ? [node] : []));
}

describe("what is written for a diagram", () => {
  it("writes the Diagram node as { alt, src } with the hashed name, and no source", async () => {
    const { build, code, stderr } = await buildWith();
    expect(stderr).toBe("");
    expect(code).toBe(0);

    const nodes = diagramNodes(lessonJson(build, "01-types").tree);

    expect(nodes).toHaveLength(8);
    for (const node of nodes) {
      expect(Object.keys(node.props)).toEqual(["alt", "src"]);
      expect(node.props.src).toMatch(/^\/api\/courses\/mermaid-course\/assets\/diagram-[0-9a-f]{16}\.svg$/);
    }
    expect(nodes[0]?.props.alt).toBe("A learner takes the quiz; if they pass they go to the next chapter, otherwise they try again");
    expect(treeErrors(lessonJson(build, "01-types").tree)).toEqual([]);
  });

  it("writes the file <build>/public/assets/<course_id>/diagram-<first 16 hex digits of the SHA-256 of the SVG bytes>.svg next to the other assets", async () => {
    const { build } = await buildWith();
    const files = filesOf(join(build, "public", "assets", "mermaid-course"));

    expect(files.size).toBe(10);
    for (const [name, bytes] of files) {
      expect(name).toMatch(BACKEND_FILE_NAME);
      const { createHash } = await import("node:crypto");
      expect(name).toBe(`diagram-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.svg`);
    }
  });

  it("has an entry in assets-map/<course_id>.json for each file, with its file, full sha256, and size, under a key that no file in assets/ can have", async () => {
    const { build } = await buildWith();
    const map = assetMap(build);
    const entries = Object.entries(map.files);

    expect(entries).toHaveLength(10);
    for (const [key, entry] of entries) {
      expect(key).toMatch(/^mermaid:[0-9a-f]{16}\.svg$/);
      expect(key).toContain(":");
      expect(Object.keys(entry)).toEqual(["file", "sha256", "size"]);
      expect(entry.file).toMatch(BACKEND_FILE_NAME);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(key).toBe(`mermaid:${entry.sha256.slice(0, 16)}.svg`);
      const bytes = readFileSync(join(build, "public", "assets", "mermaid-course", entry.file));
      expect(bytes.length).toBe(entry.size);
    }
    expect(Object.keys(map.files)).toEqual([...Object.keys(map.files)].sort());
  });

  it("keeps schema_version 2 in the manifest", async () => {
    const { build } = await buildWith();

    expect(JSON.parse(readFileSync(join(build, "private", "courses", "mermaid-course.json"), "utf8")).schema_version).toBe(2);
  });

  it("gives two diagrams with the same bytes (also in different lessons) one file, and different bytes two files", async () => {
    const { build } = await buildWith();
    const types = diagramNodes(lessonJson(build, "01-types").tree).map((node) => node.props.src);
    const repeats = diagramNodes(lessonJson(build, "01-repeats").tree).map((node) => node.props.src);

    // The second lesson's first graph has the alt text of the first lesson's graph.
    expect(repeats[0]).toBe(types[1]);
    expect(repeats[1]).not.toBe(repeats[0]);
    expect(new Set([...types, ...repeats]).size).toBe(10);
    expect(svgFiles(build)).toHaveLength(10);
  });

  it("keeps the file name of a diagram whose source did not change, when another diagram changes", async () => {
    const first = await buildWith();
    const second = await buildWith({ courses: mermaidCourses({ [REPEATS]: readFileSync(join(FIXTURES, "mermaid", "mermaid-course", REPEATS), "utf8").replace("Practice", "Games") }) });

    const [one, two] = [lessonJson(first.build, "01-types").tree, lessonJson(second.build, "01-types").tree];
    expect(diagramNodes(two).map((node) => node.props.src)).toEqual(diagramNodes(one).map((node) => node.props.src));
    expect(diagramNodes(lessonJson(second.build, "01-repeats").tree)[2]?.props.src).not.toBe(diagramNodes(lessonJson(first.build, "01-repeats").tree)[2]?.props.src);
  });

  it("never writes the Mermaid text: a comment line in a source is in no file under public/, private/, or assets-map/", async () => {
    const sentinel = "%% MERMAID-SOURCE-SENTINEL";
    const courses = mermaidCourses();
    expect(readFileSync(join(courses, "mermaid-course", TYPES), "utf8")).toContain(sentinel.slice(3));

    const { build } = await buildWith({ courses });

    for (const [path, bytes] of filesOf(build)) {
      expect(bytes.toString("latin1"), path).not.toContain("SENTINEL");
      expect(bytes.toString("latin1"), path).not.toContain('"source"');
    }
  });

  it("puts nothing of private/ under public/", async () => {
    const { build } = await buildWith();

    expect([...filesOf(join(build, "public"))].map(([path]) => path).filter((path) => /private|lessons|quizzes|\.json$/.test(path))).toEqual([]);
  });

  it("writes the SVG with an accessible name from alt, and the escaped alt text", async () => {
    const courses = mermaidCourses({ [TYPES]: lesson('<Diagram alt="Tom &amp; &quot;Jerry&quot; &lt;b&gt;" source="graph TD\n A --> B" />') });
    const { build, code } = await buildWith({ courses });
    expect(code).toBe(0);

    const folder = join(build, "public", "assets", "mermaid-course");
    const svgs = svgFiles(build).map((file) => readFileSync(join(folder, file), "utf8")).filter((text) => text.includes("Jerry"));
    expect(svgs).toHaveLength(1);
    const svg = svgs[0] as string;

    expect(svg).toMatch(/<svg [^>]*\srole="img"[^>]*\saria-labelledby="diagram-title"[^>]*><title id="diagram-title">Tom &amp; "Jerry" &lt;b&gt;<\/title>/);
    expect(svg).not.toContain("<b>");
  });

  it("leaves a Diagram with src alone, as the earlier steps wrote it", async () => {
    const { build, code } = await buildWith({ courses: VALID_COURSES, renderer: fakeRenderer() }).then((built) => ({ build: built.build, code: built.code }));
    expect(code).toBe(0);

    const tree = JSON.parse(readFileSync(join(build, "private", "lessons", "sample-course", "01-next.json"), "utf8")).tree as LessonTree;

    expect(diagramNodes(tree)[0]?.props).toEqual({ alt: "A request goes from one box to another", src: expect.stringMatching(/^\/api\/courses\/sample-course\/assets\/flow-[0-9a-f]{16}\.svg$/) });
  });
});

describe("when the browser is needed", () => {
  it("does not start it for a course with no Diagram source, which builds with a factory that throws", async () => {
    const { code, stderr, build } = await buildWith({ courses: VALID_COURSES, renderer: { ...fakeRenderer(), factory: forbiddenRenderer } });

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(existsSync(join(build, "public"))).toBe(true);
  });

  it("does not start it when every diagram is in the cache, and gives the same bytes as the build that filled the cache", async () => {
    const cold = await buildWith();
    const warm = await buildWith({ cache: cold.cache, renderer: { ...fakeRenderer(), factory: forbiddenRenderer } });

    expect(warm.stderr).toBe("");
    expect(warm.code).toBe(0);
    expect(snapshotOf(warm.build)).toEqual(snapshotOf(cold.build));
  });

  it("starts it once for a build with several diagrams that are not cached, draws each source once, and closes it", async () => {
    const built = await buildWith();

    expect(built.renderer.starts()).toBe(1);
    expect(built.renderer.drawn).toHaveLength(9);
    expect(new Set(built.renderer.drawn).size).toBe(9);
    expect(built.renderer.closed()).toBe(1);
  });

  it("draws only what is not in the cache", async () => {
    const first = await buildWith();
    const second = await buildWith({
      cache: first.cache,
      courses: mermaidCourses({ [REPEATS]: readFileSync(join(FIXTURES, "mermaid", "mermaid-course", REPEATS), "utf8").replace("Practice", "Games") }),
    });

    expect(second.renderer.starts()).toBe(1);
    expect(second.renderer.drawn).toHaveLength(1);
  });

  it("does not draw again when only the alt text changes, and the other text is in the new title", async () => {
    const original = readFileSync(join(FIXTURES, "mermaid", "mermaid-course", TYPES), "utf8");
    const first = await buildWith();
    const second = await buildWith({ cache: first.cache, courses: mermaidCourses({ [TYPES]: original.replace('alt="A request goes to the server, which asks the database"', 'alt="Three boxes"') }), renderer: { ...fakeRenderer(), factory: forbiddenRenderer } });

    expect(second.code).toBe(0);
    expect(svgFiles(second.build)).not.toEqual(svgFiles(first.build));
    expect(filesOf(join(second.build, "public"))).not.toEqual(filesOf(join(first.build, "public")));
  });

  it("treats a CRLF source as the same source: it is a cache hit", async () => {
    const original = readFileSync(join(FIXTURES, "mermaid", "mermaid-course", REPEATS), "utf8");
    const first = await buildWith();
    const second = await buildWith({ cache: first.cache, courses: mermaidCourses({ [REPEATS]: original.replaceAll("\n", "\r\n") }), renderer: { ...fakeRenderer(), factory: forbiddenRenderer } });

    expect(second.code).toBe(0);
    expect(snapshotOf(second.build)).toEqual(snapshotOf(first.build));
  });

  it("draws again after the config, the version of mermaid, mermaid-cli, or Chromium, or the post-processing changes (a new cache key)", async () => {
    const versions = { mermaid: "12.2.0", mermaidCli: "12.0.0", chromium: "156.0.8078.47" };
    const first = await buildWith({ extra: { versions } });
    expect(first.renderer.drawn).toHaveLength(9);

    for (const change of [{ mermaid: "12.2.1" }, { mermaidCli: "12.0.1" }, { chromium: "156.0.8078.48" }]) {
      const again = await buildWith({ cache: first.cache, extra: { versions: { ...versions, ...change } } });
      expect(again.renderer.drawn, JSON.stringify(change)).toHaveLength(9);
    }

    const config = join(temporaryFolder(), "mermaid-config.json");
    writeFileSync(config, readFileSync(join(PART_DIR, "mermaid-config.json"), "utf8").replace('"fontSize": "16px"', '"fontSize": "17px"'));
    const changedConfig = await buildWith({ cache: first.cache, extra: { versions, mermaidConfigPath: config } });
    expect(changedConfig.renderer.drawn).toHaveLength(9);

    const same = await buildWith({ cache: first.cache, extra: { versions }, renderer: { ...fakeRenderer(), factory: forbiddenRenderer } });
    expect(same.code).toBe(0);
  });

  it("ignores a cache entry that is empty, is not UTF-8, or fails the SVG rules, and draws that diagram again", async () => {
    const first = await buildWith();
    const files = readdirSync(first.cache).filter((name) => name.endsWith(".svg")).sort();
    expect(files).toHaveLength(9);
    writeFileSync(join(first.cache, files[0] as string), "");
    writeFileSync(join(first.cache, files[1] as string), Buffer.from([0xff, 0xfe, 0x00]));
    writeFileSync(join(first.cache, files[2] as string), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    writeFileSync(join(first.cache, files[3] as string), "<svg>not what finishSvg writes</svg>");

    const second = await buildWith({ cache: first.cache });

    expect(second.code).toBe(0);
    expect(second.renderer.drawn).toHaveLength(4);
    expect(snapshotOf(second.build)).toEqual(snapshotOf(first.build));
  });

  it("keeps the cache outside the build folder, and a build never deletes it", async () => {
    const first = await buildWith();
    const before = readdirSync(first.cache).sort();

    const second = await buildWith({ cache: first.cache, build: first.build });

    expect(readdirSync(second.cache).sort()).toEqual(before);
    expect(first.cache.startsWith(first.build)).toBe(false);
    expect([...filesOf(first.build).keys()].some((path) => path.endsWith(".tmp") || path.includes("cache"))).toBe(false);
  });

  it("uses MERMAID_CACHE_DIR when no cache folder is given", async () => {
    const cache = join(temporaryFolder(), "from-env");
    const renderer = fakeRenderer();

    await runBuild([mermaidCourses(), newBuildFolder()], { rendererFactory: renderer.factory, env: { MERMAID_CACHE_DIR: cache } });

    expect(readdirSync(cache).filter((name) => name.endsWith(".svg"))).toHaveLength(9);
  });
});

describe("the errors of diagrams", () => {
  const syntax = (line: number) =>
    new DiagramRenderError("mermaid", `Parse error on line ${line}:\n...A --> B C -->\n-----------^\nExpecting 'AMP', 'COLON', got 'EOF'`);

  /** A renderer that fails for sources that hold `marker`, with `error`. */
  function failing(marker: string, error: Error) {
    return fakeRenderer((source) => (source.includes(marker) ? error : fakeSvg(source)));
  }

  it("fails the build with <lesson path>:<line>:<column>: error: Mermaid could not parse this diagram: <Mermaid message>, at the lesson line of the line Mermaid names", async () => {
    const body = ["Text.", "", "<Diagram", '  alt="Broken"', '  source="flowchart LR', "    A --> B", '    C --> "', "/>"].join("\n");
    const courses = mermaidCourses({ [TYPES]: lesson(body) });

    const { code, stdout, stderr } = await buildWith({ courses, renderer: failing("C -->", syntax(3)) });

    // The source starts on line 10 (the front matter and the title take 5 lines, then the text, a blank line, <Diagram, and alt); its third line is line 12.
    expect(stderr).toBe("");
    expect(code).toBe(1);
    expect(stdout).toContain(`${courses.replaceAll("\\", "/")}/mermaid-course/${TYPES}:12:1: error: Mermaid could not parse this diagram: Parse error on line 3: ...A --> B C --> -----------^ Expecting 'AMP', 'COLON', got 'EOF'`);
    expect(stdout.trimEnd().split("\n").at(-1)).toBe("1 error(s), 0 warning(s)");
  });

  it("counts the lines Mermaid names after it drops the leading blank lines and the comment lines (a source that starts with a blank line)", async () => {
    // Mermaid sees: flowchart LR / A --> B / C -->  and names line 3, which is the 6th line of the source.
    const body = ["<Diagram", '  alt="Broken"', '  source="', "    %% a comment", "", "    flowchart LR", "    A --> B", '    C --> "', "/>"].join("\n");
    const courses = mermaidCourses({ [TYPES]: lesson(body) });

    const { stdout } = await buildWith({ courses, renderer: failing("C -->", syntax(3)) });

    // The prop is on line 8, so source line 1 is line 8 and source line 6 ("    C --> ") is line 13.
    expect(stdout).toContain(`${TYPES}:13:1: error: Mermaid could not parse this diagram:`);
  });

  it("puts the error on the column of the prop when the error is on the first line of the source, and on the line of the prop when Mermaid names no line", async () => {
    const courses = mermaidCourses({ [TYPES]: lesson('<Diagram alt="A" source="graph TD\n A --> B" />') });

    const first = await buildWith({ courses, renderer: failing("A -->", syntax(1)) });
    const none = await buildWith({ courses, renderer: failing("A -->", new DiagramRenderError("mermaid", "Something odd")) });

    expect(first.stdout).toContain(`${TYPES}:6:18: error: Mermaid could not parse this diagram:`);
    expect(none.stdout).toContain(`${TYPES}:6:18: error: Mermaid could not parse this diagram: Something odd`);
  });

  it("lists every diagram error of every lesson, in lesson order, with the other problems, and one bad diagram does not hide another", async () => {
    // A lesson with an unknown component is not drawn, so the unknown component is in the other lesson.
    const courses = mermaidCourses({
      [TYPES]: lesson("<Unknown />"),
      [REPEATS]: lesson('<Diagram alt="A" source="graph TD\n A --> B\n bad two" />\n\n<Diagram alt="B" source="pie\n  bad three" />'),
    });

    const { code, stdout } = await buildWith({ courses, renderer: fakeRenderer((source) => (source.includes("bad") ? syntax(2) : fakeSvg(source))) });

    expect(code).toBe(1);
    const lines = stdout.trimEnd().split("\n");
    const errors = lines.filter((line) => line.includes(": error:"));
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain("unknown component `Unknown`");
    expect(errors[1]).toContain(`${REPEATS}:7:`);
    expect(errors[2]).toContain(`${REPEATS}:11:`);
    expect(lines.at(-1)).toBe("3 error(s), 0 warning(s)");
  });

  it("lists the errors of the lessons in lesson order: the first chapter before the second", async () => {
    const courses = mermaidCourses({
      [TYPES]: lesson('<Diagram alt="A" source="graph TD\n bad one" />'),
      [REPEATS]: lesson('<Diagram alt="B" source="graph TD\n bad two" />'),
    });

    const { stdout } = await buildWith({ courses, renderer: fakeRenderer((source) => (source.includes("bad") ? syntax(2) : fakeSvg(source))) });

    const errors = stdout.split("\n").filter((line) => line.includes(": error:"));
    expect(errors.map((line) => (line.includes("01-diagram-types") ? 1 : 2))).toEqual([1, 2]);
  });

  it("reports a failing source at each place it is used", async () => {
    const courses = mermaidCourses({
      [TYPES]: lesson('<Diagram alt="A" source="graph TD\n bad" />'),
      [REPEATS]: lesson('<Diagram alt="B" source="graph TD\n bad" />'),
    });
    const renderer = fakeRenderer((source) => (source.includes("bad") ? syntax(2) : fakeSvg(source)));

    const { stdout } = await buildWith({ courses, renderer });

    expect(stdout.split("\n").filter((line) => line.includes(": error:"))).toHaveLength(2);
    expect(renderer.drawn).toHaveLength(1);
  });

  it("leaves the build folder exactly as it was: nothing created, changed, or removed (all or nothing)", async () => {
    const build = newBuildFolder();
    await buildWith({ build });
    mkdirSync(join(build, "private", "extra"), { recursive: true });
    writeFileSync(join(build, "private", "extra", "keep.txt"), "kept");
    const before = snapshotOf(build);
    const courses = mermaidCourses({ [TYPES]: lesson('<Diagram alt="A" source="graph TD\n bad" />') });

    const { code } = await buildWith({ build, courses, renderer: fakeRenderer((source) => (source.includes("bad") ? syntax(2) : fakeSvg(source))) });

    expect(code).toBe(1);
    expect(snapshotOf(build)).toEqual(before);
  });

  it("creates no build folder at all when the first build fails", async () => {
    const build = newBuildFolder();
    const courses = mermaidCourses({ [TYPES]: lesson('<Diagram alt="A" source="graph TD\n bad" />') });

    await buildWith({ build, courses, renderer: fakeRenderer(() => syntax(1)) });

    expect(existsSync(build)).toBe(false);
  });

  it("makes a timeout and a crash errors at the <Diagram> tag that say which one it was", async () => {
    const body = ["<Diagram", '  alt="Slow"', '  source="graph TD', '  slow"', "/>", "", '<Diagram alt="Crash" source="graph TD\n crash" />'].join("\n");
    const courses = mermaidCourses({ [TYPES]: lesson(body) });
    const renderer = fakeRenderer((source) =>
      source.includes("slow") ? new DiagramRenderError("timeout", "drawing this diagram took longer than 30 seconds, so it was stopped; make the diagram smaller") : source.includes("crash") ? new DiagramRenderError("crash", "the browser crashed while it drew this diagram; run the build again") : fakeSvg(source),
    );

    const { code, stdout } = await buildWith({ courses, renderer });

    expect(code).toBe(1);
    expect(stdout).toContain(`${TYPES}:6:1: error: drawing this diagram took longer than 30 seconds`);
    expect(stdout).toContain(`${TYPES}:12:1: error: the browser crashed while it drew this diagram`);
    expect(stdout).not.toContain("Mermaid could not parse");
  });

  it.each([
    ["a foreignObject", '<foreignObject width="1" height="1"/>', "foreignObject"],
    ["a script", "<script>alert(1)</script>", "script"],
    ["an event handler", '<rect onclick="x()"/>', "onclick"],
    ["a link to another file", '<a href="https://example.com"><rect/></a>', "href"],
    ["an xlink link to another file", '<image xlink:href="http://127.0.0.1:1/x.png"/>', "href"],
    ["an @import", "<style>@import url(#a);</style>", "@import"],
    ["a url() to another file", '<rect style="fill:url(https://example.com/a)"/>', "url("],
  ])("fails closed on %s in the rendered SVG: an error at the <Diagram> tag that names the rule and says the problem is in the rendered diagram, and no file is written", async (_name, extra, rule) => {
    const courses = mermaidCourses({ [TYPES]: lesson('Text.\n\n<Diagram alt="A" source="graph TD\n A --> B" />') });
    const renderer = fakeRenderer((source) => fakeSvg(source, extra));

    const { code, stdout, build, cache } = await buildWith({ courses, renderer });

    expect(code).toBe(1);
    expect(stdout).toContain(`${TYPES}:8:1: error: the diagram that Mermaid drew breaks an SVG rule`);
    expect(stdout).toContain("the problem is in the rendered diagram");
    expect(stdout).toContain(rule);
    expect(existsSync(build)).toBe(false);
    expect(existsSync(cache) ? readdirSync(cache).filter((name) => name.endsWith(".svg")) : []).toEqual([]);
  });

  it("does not strip or repair anything: an SVG that fails is not written, and its text is not in the build", async () => {
    const courses = mermaidCourses({ [TYPES]: lesson('<Diagram alt="A" source="graph TD\n A --> B" />') });
    const build = newBuildFolder();

    await buildWith({ courses, build, renderer: fakeRenderer((source) => fakeSvg(source, "<script>alert(1)</script>")) });

    expect(existsSync(build)).toBe(false);
  });
});

describe("the size of a rendered diagram", () => {
  function mediaConfig(imageBytes: number): string {
    const config = JSON.parse(readFileSync(join(PART_DIR, "media-config.json"), "utf8"));
    config.assetLimits.imageBytes = imageBytes;
    const path = join(temporaryFolder(), "media-config.json");
    writeFileSync(path, JSON.stringify(config));
    return path;
  }

  const courses = () => mermaidCourses({ [TYPES]: lesson('<Diagram alt="A" source="graph TD\n A --> B" />'), [REPEATS]: lesson("No diagram here.") });

  it("passes an SVG of exactly assetLimits.imageBytes and fails one byte more, naming the size and the limit", async () => {
    const probe = await buildWith({ courses: courses() });
    const size = Object.values(assetMap(probe.build).files)[0]?.size as number;

    const exact = await buildWith({ courses: courses(), extra: { mediaConfigPath: mediaConfig(size) } });
    const over = await buildWith({ courses: courses(), extra: { mediaConfigPath: mediaConfig(size - 1) } });

    expect(exact.code).toBe(0);
    expect(over.code).toBe(1);
    expect(over.stdout).toContain(`${TYPES}:6:1: error: the rendered diagram is ${size} bytes, but the most allowed for an image file is ${size - 1} bytes`);
  });
});

describe("determinism", () => {
  it("builds the same files into two build folders: lesson trees, SVGs, and map, byte for byte", async () => {
    const [one, two] = [await buildWith(), await buildWith()];

    expect([...filesOf(one.build).keys()].length).toBeGreaterThan(10);
    expect(snapshotOf(one.build)).toEqual(snapshotOf(two.build));
  });

  it("writes no absolute path, date, or random id to any file", async () => {
    const { build } = await buildWith();

    for (const [path, bytes] of filesOf(build)) {
      const text = bytes.toString("utf8");
      expect(text, path).not.toMatch(/\/tmp|\/home\/|[A-Za-z]:\\|file:|\b(?:19|20)\d\d-\d\d-\d\d\b/);
    }
  });
});

describe("the build setup", () => {
  it("is a setup error (exit 3) when mermaid-config.json is not valid, and only when a diagram needs it", async () => {
    const config = join(temporaryFolder(), "mermaid-config.json");
    writeFileSync(config, readFileSync(join(PART_DIR, "mermaid-config.json"), "utf8").replace('"securityLevel": "strict"', '"securityLevel": "loose"'));

    const bad = await buildWith({ extra: { mermaidConfigPath: config } });
    const unused = await buildWith({ courses: VALID_COURSES, extra: { mermaidConfigPath: config } });

    expect(bad.code).toBe(3);
    expect(bad.stderr).toBe("build setup error: mermaid-config.json: `securityLevel` must be equal to constant\n");
    expect(unused.code).toBe(0);
  });

  describe("with no browser installed", () => {
    /** Runs a command of the part in a child process whose puppeteer cache is an empty folder, so no browser is installed. */
    function run(script: string, args: string[], extraEnv: Record<string, string> = {}) {
      const empty = temporaryFolder();
      return spawnSync(process.execPath, [join(PART_DIR, "src", script), ...args], {
        cwd: temporaryFolder(),
        encoding: "utf8",
        env: { ...process.env, PUPPETEER_CACHE_DIR: empty, PUPPETEER_EXECUTABLE_PATH: "", MERMAID_CACHE_DIR: join(temporaryFolder(), "cache"), COURSES: "", ...extraEnv },
      });
    }

    it("prints build setup error, exits 3, names the folder it looked in, says to run make install-content-build, and has no stack trace", () => {
      const result = run("build.ts", [join(FIXTURES, "mermaid"), newBuildFolder()]);

      expect(result.status).toBe(3);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/^build setup error: Chromium \(chrome-headless-shell [\d.]+\) is not installed: it is not in .*chrome-headless-shell; run `make install-content-build`/);
      expect(result.stderr.split("\n").filter((line) => line !== "")).toHaveLength(1);
      expect(result.stderr).not.toMatch(/\n\s+at |Error:/);
    }, SLOW_PROCESS_TIMEOUT_MS);

    it("builds a course with no Diagram source, and validates the Mermaid fixture, without it", () => {
      const build = newBuildFolder();
      const built = run("build.ts", [VALID_COURSES, build]);
      const validated = run("validate.ts", [join(FIXTURES, "mermaid", "mermaid-course")]);

      expect(built.stderr).toBe("");
      expect(built.status).toBe(0);
      expect(validated.status).toBe(0);
      expect(validated.stdout).toBe("0 error(s), 0 warning(s)\n");
    }, SLOW_PROCESS_TIMEOUT_MS);

    it("compiles a lesson with a Diagram source, and checks ids, without it, and the compile output is the tree with source as written", () => {
      const lessonFile = join(FIXTURES, "mermaid", "mermaid-course", TYPES);
      const compiled = run("compile.ts", [lessonFile]);
      const courses = temporaryFolder();
      cpSync(join(FIXTURES, "mermaid"), courses, { recursive: true });
      const ids = run("ids-check.ts", [courses]);

      expect(compiled.status).toBe(0);
      expect(compiled.stdout).toContain('"source": "flowchart TD');
      expect(ids.stderr).not.toContain("Chromium");
    }, SLOW_PROCESS_TIMEOUT_MS);
  });
});
