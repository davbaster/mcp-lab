// The real renderer (tier 2): Chromium draws the diagrams. Same input gives the same bytes, the safety checks hold against what
// Mermaid really writes, and the failures (a syntax error, a timeout, a crash) come out as the build reports them.
// These tests need `make install-content-build` (they fail with the setup error if the browser is not installed).

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import puppeteer from "puppeteer";
import type { Browser, LaunchOptions } from "puppeteer";
import { beforeAll, describe, expect, it } from "vitest";
import { diagramType } from "../src/diagram-source.ts";
import { DiagramRenderError, chromiumBuild } from "../src/mermaid-render.ts";
import { svgProblems } from "../src/svg.ts";
import { VALID_COURSES, filesOf, newBuildFolder, runBuild } from "./build-support.ts";
import { temporaryFolder } from "./helpers.ts";
import { BROWSER_TEST_TIMEOUT_MS, COMPARES_WITH_GOLDEN, MERMAID_GOLDEN, NOT_REFERENCE_PLATFORM, TYPES_LESSON, lesson, mermaidCourses, firstDifference, realRenderer, typesLessonUses } from "./mermaid-helpers.ts";

const REPEATS = "chapters/02-more-diagrams/lessons/01-repeats.mdx";
const NO_DIAGRAM = lesson("No diagram here.");

/** The one diagram of each type in the fixture: its type (the golden's name) and its source. */
const TYPED = typesLessonUses().map((use) => ({ type: diagramType(use.source)?.type as string, source: use.source }));

/** Builds `body` as the only lesson with diagrams, with the real renderer and a cache of its own. */
async function buildBody(body: string) {
  const courses = mermaidCourses({ [TYPES_LESSON]: lesson(body), [REPEATS]: NO_DIAGRAM });
  const build = newBuildFolder();
  const result = await runBuild([courses, build], { cacheDir: join(temporaryFolder(), "cache") });
  return { courses, build, ...result };
}

const assetsOf = (build: string) => [...filesOf(join(build, "public", "assets", "mermaid-course"))].map(([name, bytes]) => ({ name, text: bytes.toString("utf8") }));

describe("the same source gives the same bytes (all supported types)", () => {
  const renders: { forward: Map<string, string>; reverse: Map<string, string>; fresh: Map<string, string> } = { forward: new Map(), reverse: new Map(), fresh: new Map() };

  beforeAll(async () => {
    const draw = async (sources: typeof TYPED) => {
      const renderer = await realRenderer();
      try {
        const out = new Map<string, string>();
        for (const { type, source } of sources) out.set(type, await renderer.render(source));
        return { renderer, out };
      } finally {
        await renderer.close();
      }
    };
    // One browser: the types in order, then again in the reverse order. Then a new browser.
    const renderer = await realRenderer();
    try {
      for (const { type, source } of TYPED) renders.forward.set(type, await renderer.render(source));
      for (const { type, source } of [...TYPED].reverse()) renders.reverse.set(type, await renderer.render(source));
    } finally {
      await renderer.close();
    }
    renders.fresh = (await draw(TYPED)).out;
  }, BROWSER_TEST_TIMEOUT_MS);

  it("has one diagram of each of the eight supported types in the fixture", () => {
    expect(TYPED.map(({ type }) => type).sort()).toEqual(["classDiagram", "erDiagram", "flowchart", "graph", "pie", "sequenceDiagram", "stateDiagram", "stateDiagram-v2"]);
  });

  it.each(TYPED.map(({ type }) => type))("%s: twice in one browser, in the reverse order, and in a new browser gives byte-identical SVG that passes the SVG rules", (type) => {
    const forward = renders.forward.get(type) ?? "";

    expect(forward).toMatch(/^<svg\b/);
    expect(svgProblems(forward)).toEqual([]);
    expect(firstDifference(renders.reverse.get(type) ?? "", forward)).toBe("");
    expect(firstDifference(renders.fresh.get(type) ?? "", forward)).toBe("");
  });

  // Skipped on Windows only, one test per type: the goldens are the Linux bytes (NOT_REFERENCE_PLATFORM says why).
  it.skipIf(!COMPARES_WITH_GOLDEN).each(TYPED.map(({ type }) => type))(`%s: the three renders equal the golden file byte for byte (not run on Windows: ${NOT_REFERENCE_PLATFORM})`, (type) => {
    const golden = readFileSync(join(MERMAID_GOLDEN, "renderer", `${type}.svg`), "utf8");

    expect(firstDifference(renders.forward.get(type) ?? "", golden)).toBe("");
    expect(firstDifference(renders.reverse.get(type) ?? "", golden)).toBe("");
    expect(firstDifference(renders.fresh.get(type) ?? "", golden)).toBe("");
  });
});

describe.runIf(process.platform === "linux")("Linux only: a fontconfig with one font gives the same bytes as the default fonts (fontconfig is a Linux library)", () => {
  /**
   * The font file that is the only font of the fontconfig below: the first of these regular sans fonts that the machine has, else the
   * first font file by path. Mermaid also measures each text in the machine's `sans-serif` and uses that measure when it is both wider
   * and taller than the bundled font, so a very wide or heavy face (Inter Black, a monospace font) would change a sequence or ER
   * diagram; the README lists this as a known limit. A regular sans font is what a machine has by default.
   */
  function someFont(): string {
    const found: string[] = [];
    for (const root of ["/usr/share/fonts", "/usr/local/share/fonts"]) {
      if (!existsSync(root)) continue;
      found.push(
        ...readdirSync(root, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile() && /\.(ttf|otf)$/i.test(entry.name))
          .map((entry) => join(entry.parentPath, entry.name)),
      );
    }
    found.sort();
    for (const name of ["DejaVuSans.ttf", "LiberationSans-Regular.ttf", "NotoSans-Regular.ttf", "Arimo-Regular.ttf", "FreeSans.ttf"]) {
      const preferred = found.find((path) => path.endsWith(`/${name}`));
      if (preferred !== undefined) return preferred;
    }
    if (found[0] === undefined) throw new Error("this machine has no .ttf or .otf font under /usr/share/fonts to put in the one-font fontconfig");
    return found[0];
  }

  function oneFontConfig(): { file: string; env: Record<string, string> } {
    const folder = temporaryFolder();
    mkdirSync(join(folder, "fonts"));
    copyFileSync(someFont(), join(folder, "fonts", "only.ttf"));
    const file = join(folder, "fonts.conf");
    writeFileSync(
      file,
      `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n<fontconfig><dir>${join(folder, "fonts")}</dir><cachedir>${join(folder, "cache")}</cachedir></fontconfig>\n`,
    );
    return { file, env: { FONTCONFIG_FILE: file } };
  }

  it("draws every fixture type to the golden bytes with only one font installed", async () => {
    const { file, env } = oneFontConfig();
    // Without this the test could pass because the setting did nothing: when fc-list exists, it lists one font with this file.
    const listed = spawnSync("fc-list", [], { env: { ...process.env, ...env }, encoding: "utf8" });
    if (listed.status === 0) expect(listed.stdout.trim().split("\n")).toHaveLength(1);
    expect(existsSync(file)).toBe(true);

    const launch = (options: LaunchOptions) => puppeteer.launch({ ...options, env: { ...process.env, ...env } });
    const renderer = await realRenderer({ launch });
    try {
      for (const { type, source } of TYPED) {
        expect(firstDifference(await renderer.render(source), readFileSync(join(MERMAID_GOLDEN, "renderer", `${type}.svg`), "utf8")), type).toBe("");
      }
    } finally {
      await renderer.close();
    }
  }, BROWSER_TEST_TIMEOUT_MS);
});

describe("how the real browser is started", () => {
  it("starts the build of chrome-headless-shell that puppeteer pins, which is installed", async () => {
    const build = await chromiumBuild();
    const executable = await puppeteer.executablePath({ headless: "shell" });
    let version = "";
    const launch = async (options: LaunchOptions): Promise<Browser> => {
      const browser = await puppeteer.launch(options);
      version = await browser.version();
      return browser;
    };

    expect(executable).toContain("chrome-headless-shell");
    expect(executable).toContain(build);
    expect(existsSync(executable)).toBe(true);
    await (await realRenderer({ launch })).close();
    expect(version).toBe(`HeadlessChrome/${build}`);
  }, BROWSER_TEST_TIMEOUT_MS);

  it("uses a temporary profile and removes it when the renderer is closed", async () => {
    let profile: string | undefined;
    const launch = (options: LaunchOptions) => {
      profile = options.userDataDir;
      return puppeteer.launch(options);
    };
    const renderer = await realRenderer({ launch });
    await renderer.render("graph TD\n A --> B");
    expect(existsSync(profile as string)).toBe(true);

    await renderer.close();

    expect(profile).toMatch(/mermaid-profile-/);
    expect(existsSync(profile as string)).toBe(false);
  }, BROWSER_TEST_TIMEOUT_MS);

  it("makes a diagram that takes too long a timeout error, and throws that browser away", async () => {
    const browsers: Browser[] = [];
    const launch = async (options: LaunchOptions) => {
      const browser = await puppeteer.launch(options);
      browsers.push(browser);
      return browser;
    };
    const renderer = await realRenderer({ launch, timeoutMs: 1 });

    const error = await renderer.render("graph TD\n A --> B").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DiagramRenderError);
    expect((error as DiagramRenderError).kind).toBe("timeout");
    expect((error as DiagramRenderError).message).toBe("drawing this diagram took longer than 0.001 seconds, so it was stopped; make the diagram smaller");
    expect(browsers).toHaveLength(1);
    expect(browsers[0]?.connected).toBe(false);
    await renderer.close();
  }, BROWSER_TEST_TIMEOUT_MS);

  it("makes a browser that dies a crash error, and the next diagram gets a new browser", async () => {
    const browsers: Browser[] = [];
    const launch = async (options: LaunchOptions) => {
      const browser = await puppeteer.launch(options);
      browsers.push(browser);
      return browser;
    };
    const renderer = await realRenderer({ launch });
    try {
      const golden = readFileSync(join(MERMAID_GOLDEN, "renderer", "graph.svg"), "utf8");
      const graph = TYPED.find(({ type }) => type === "graph")?.source as string;
      const before = await renderer.render(graph);
      // Only the comparison with the Linux bytes depends on the platform; the test then compares with the same machine's own bytes.
      if (COMPARES_WITH_GOLDEN) expect(firstDifference(before, golden)).toBe("");
      browsers[0]?.process()?.kill("SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 500));

      const error = await renderer.render(graph).catch((caught: unknown) => caught);

      expect((error as DiagramRenderError).kind).toBe("crash");
      expect((error as DiagramRenderError).message).toBe("the browser crashed while it drew this diagram; run the build again");
      const after = await renderer.render(graph);
      expect(firstDifference(after, before)).toBe("");
      if (COMPARES_WITH_GOLDEN) expect(firstDifference(after, golden)).toBe("");
      expect(browsers).toHaveLength(2);
    } finally {
      await renderer.close();
    }
  }, BROWSER_TEST_TIMEOUT_MS);
});

describe("what Mermaid really writes passes the SVG rules, or the build fails closed", () => {
  it("shows HTML in a label as text or drops it: <img onerror> and <script> are in no file", async () => {
    const { code, stdout, build } = await buildBody('<Diagram alt="Labels" source=\'flowchart TD\n A["<img src=x onerror=alert(1)>"] --> B["<script>alert(1)</script>"]\' />');

    expect(stdout).toContain("0 error(s), 0 warning(s)");
    expect(code).toBe(0);
    const files = assetsOf(build);
    expect(files).toHaveLength(1);
    for (const { text } of files) {
      expect(svgProblems(text)).toEqual([]);
      expect(text).not.toMatch(/onerror|<script|<img|foreignObject/i);
    }
  }, BROWSER_TEST_TIMEOUT_MS);

  it("fails the build through the href rule for a link that a sequence diagram makes (`link`, `links`)", async () => {
    const body = [
      "<Diagram",
      '  alt="Link"',
      "  source='sequenceDiagram",
      "    participant A",
      "    link A: Dashboard @ https://example.com",
      "    A->>B: hi'",
      "/>",
    ].join("\n");

    const { code, stdout, build } = await buildBody(body);

    expect(code).toBe(1);
    expect(stdout).toContain(`${TYPES_LESSON}:6:1: error: the diagram that Mermaid drew breaks an SVG rule, so it is not written (the problem is in the rendered diagram, not in the lesson text)`);
    expect(stdout).toContain("href");
    expect(existsSync(build)).toBe(false);
  }, BROWSER_TEST_TIMEOUT_MS);

  it("fails the build for a node with an image from a local server, and the server gets no request (Chromium has no network)", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.writeHead(200, { "Content-Type": "image/png" }).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const body = `<Diagram alt="Image" source='flowchart TD\n A@{ img: "http://127.0.0.1:${port}/x.png", label: "x", pos: "b", w: 60, h: 60, constraint: "on" } --> B' />`;

      const { code, stdout, build } = await buildBody(body);
      // The page may start a late request after the build ends, so wait a moment before the count is read.
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(code).toBe(1);
      expect(stdout).toContain(`${TYPES_LESSON}:6:22: error:`);
      expect(stdout).not.toContain(String(port));
      expect(existsSync(build)).toBe(false);
      expect(requests).toEqual([]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, BROWSER_TEST_TIMEOUT_MS);
});

describe("accessibility with the real renderer", () => {
  it("replaces the title that accTitle writes with the alt text, and keeps the description that accDescr writes", async () => {
    const { code, build } = await buildBody('<Diagram alt="Our alt text" source=\'flowchart TD\n accTitle: Mermaid title\n accDescr: The long description\n A --> B\' />');

    expect(code).toBe(0);
    const [file] = assetsOf(build);
    const svg = file?.text as string;
    expect(svg.match(/<title\b/g)).toHaveLength(1);
    expect(svg).toContain('<title id="diagram-title">Our alt text</title>');
    expect(svg).not.toContain("Mermaid title");
    expect(svg).toMatch(/\saria-labelledby="diagram-title"/);
    expect(svg).toMatch(/\srole="img"/);
    const description = /<desc id="([^"]+)">The long description<\/desc>/.exec(svg);
    expect(description).not.toBeNull();
    expect(svg).toContain(`aria-describedby="${description?.[1]}"`);
    expect(svgProblems(svg)).toEqual([]);
  }, BROWSER_TEST_TIMEOUT_MS);
});

describe("Mermaid's errors really name the lines the build maps", () => {
  /** The 1-based line of the first line of `text` that holds `marker`. */
  const lineOf = (text: string, marker: string) => text.split("\n").findIndex((line) => line.includes(marker)) + 1;

  // Each source starts with a blank line, and has a comment line: Mermaid drops them before it counts, and the build counts them back.
  const body = [
    "<Diagram",
    '  alt="One"',
    "  source='",
    "%% a comment",
    "",
    "flowchart LR",
    "  A --> B",
    "  ONE --> )(",
    "  D --> E' />",
    "",
    "<Diagram alt=\"Two\" source='",
    "",
    "sequenceDiagram",
    "%% a comment",
    "  A->>B: hi",
    "  B->>: TWO",
    "  A->>B: x' />",
    "",
    "<Diagram alt=\"Three\" source='  ",
    "classDiagram",
    "%% a comment",
    "  class A {",
    "    +x",
    "  }",
    "  class ]THREE",
    "  class B' />",
    "",
    "<Diagram alt=\"Four\" source='pie",
    '  "a" : FOUR\' />',
  ].join("\n");

  it("fails with <lesson path>:<line>:<column>: error: Mermaid could not parse this diagram: <message> at the lesson line of the source line Mermaid names, for each diagram, in one run", async () => {
    const text = lesson(body);

    const { code, stdout, stderr } = await buildBody(body);

    expect(stderr).toBe("");
    expect(code).toBe(1);
    const errors = stdout.split("\n").filter((line) => line.includes(": error:"));
    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain(`${TYPES_LESSON}:${lineOf(text, "ONE --> )(")}:1: error: Mermaid could not parse this diagram: `);
    expect(errors[1]).toContain(`${TYPES_LESSON}:${lineOf(text, "B->>: TWO")}:1: error: Mermaid could not parse this diagram: Parse error on line 3:`);
    expect(errors[2]).toContain(`${TYPES_LESSON}:${lineOf(text, "class ]THREE")}:1: error: Mermaid could not parse this diagram: Parse error on line 5:`);
    expect(errors[3]).toContain(`${TYPES_LESSON}:${lineOf(text, "FOUR")}:1: error: Mermaid could not parse this diagram: Parsing failed:`);
    expect(stdout.trimEnd().split("\n").at(-1)).toBe("4 error(s), 0 warning(s)");
  }, BROWSER_TEST_TIMEOUT_MS);

  it("has no stack frame, no absolute path, and no URL in the message", async () => {
    const { stdout } = await buildBody(body);

    for (const line of stdout.split("\n").filter((entry) => entry.includes(": error:"))) {
      const message = line.slice(line.indexOf(": error:"));
      expect(message).not.toMatch(/\bat \S+ \(|\(https?:|file:|[A-Za-z]:\\|\/tmp\/|\/home\//);
    }
  }, BROWSER_TEST_TIMEOUT_MS);
});

describe("a course with no Diagram source does not start the browser", () => {
  it("builds the valid fixture with the real factory untouched (the browser is only started when needed)", async () => {
    const result = await runBuild([VALID_COURSES, newBuildFolder()], { cacheDir: join(temporaryFolder(), "cache") });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });
});
