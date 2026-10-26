// Shared by the diagram tests: the Mermaid fixture, a fake renderer for tier 1, and the real one for tier 2.

import { createHash } from "node:crypto";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inspectCourse } from "../src/course.ts";
import type { DiagramUse } from "../src/lesson.ts";
import { loadMermaidConfig } from "../src/mermaid-config.ts";
import { createMermaidRenderer } from "../src/mermaid-render.ts";
import type { DiagramRenderer, RendererFactory } from "../src/mermaid-render.ts";
import { FIXTURES, temporaryFolder } from "./helpers.ts";

/** The courses folder of the Mermaid fixtures: it holds the course `mermaid-course`. */
export const MERMAID_COURSES = join(FIXTURES, "mermaid");
export const MERMAID_COURSE = join(MERMAID_COURSES, "mermaid-course");
/** The golden output: `renderer/<type>.svg` (what the renderer writes) and the build folder of building `fixtures/mermaid`. */
export const MERMAID_GOLDEN = join(FIXTURES, "expected-mermaid");
/** The lesson of the fixture that has one diagram of each supported type. */
export const TYPES_LESSON = "chapters/01-diagram-types/lessons/01-types.mdx";
/** The time limit of a test that starts Chromium (a start takes 1 s on Linux and more on Windows). */
export const BROWSER_TEST_TIMEOUT_MS = 120_000;

/** The `Diagram` uses of the types lesson, in order. */
export function typesLessonUses(): DiagramUse[] {
  const lesson = inspectCourse(MERMAID_COURSE, { compileLessons: true }).lessons?.find((candidate) => candidate.file === TYPES_LESSON);
  if (lesson === undefined) throw new Error("the types lesson did not compile");
  return lesson.diagrams;
}

/**
 * A courses folder in a temporary folder with a copy of the Mermaid fixture. `changes` is a path inside the course to its new
 * content (or null to delete it). Returns the courses folder.
 */
export function mermaidCourses(changes: Record<string, string | null> = {}): string {
  const folder = join(temporaryFolder(), "courses");
  cpSync(MERMAID_COURSES, folder, { recursive: true });
  for (const [path, content] of Object.entries(changes)) {
    const target = join(folder, "mermaid-course", ...path.split("/"));
    if (content === null) {
      rmSync(target, { recursive: true, force: true });
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }
  return folder;
}

/** A lesson file with front matter and this body, for `mermaidCourses`. */
export function lesson(body: string, title = "A lesson"): string {
  return `---\ntitle: ${title}\norder: 1\n---\n\n${body}\n`;
}

/** The fake renderer's SVG: the same for the same source, different for another, and it holds a digest of the source, never the source. */
export function fakeSvg(source: string, extra = ""): string {
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
  return `<svg id="diagram" width="100%" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60" role="graphics-document document"><g><text x="1" y="1">${digest}</text>${extra}</g></svg>`;
}

export type FakeRenderer = {
  factory: RendererFactory;
  /** How many renderers were started. */
  starts: () => number;
  /** The sources that were drawn, in order. */
  drawn: string[];
  closed: () => number;
};

/** A renderer factory that draws with `draw` (default: `fakeSvg`) and counts how often it is started, used, and closed. */
export function fakeRenderer(draw: (source: string) => string | Error = (source) => fakeSvg(source)): FakeRenderer {
  let starts = 0;
  let closed = 0;
  const drawn: string[] = [];
  const factory: RendererFactory = async () => {
    starts += 1;
    const renderer: DiagramRenderer = {
      async render(source) {
        drawn.push(source);
        const result = draw(source);
        if (result instanceof Error) throw result;
        return result;
      },
      async close() {
        closed += 1;
      },
    };
    return renderer;
  };
  return { factory, starts: () => starts, drawn, closed: () => closed };
}

/** A factory that must never be called. */
export const forbiddenRenderer: RendererFactory = async () => {
  throw new Error("the browser was started, but nothing needed it");
};

/** The real renderer (Chromium) with the committed config. Close it when done. */
export async function realRenderer(options: Parameters<typeof createMermaidRenderer>[1] = {}): Promise<DiagramRenderer> {
  return createMermaidRenderer(loadMermaidConfig(), options);
}

/** The first place where two texts differ, with some text around it from each, or "" when they are the same. For failure messages that show the real difference. */
export function firstDifference(actual: string, expected: string): string {
  if (actual === expected) return "";
  let at = 0;
  while (at < actual.length && at < expected.length && actual[at] === expected[at]) at += 1;
  const around = (text: string) => JSON.stringify(text.slice(Math.max(0, at - 40), at + 40));
  const line = actual.slice(0, at).split("\n").length;
  return `differs at character ${at} (line ${line}); actual has ${actual.length} characters, expected ${expected.length}; actual ...${around(actual)}... expected ...${around(expected)}...`;
}

/**
 * How the files of `actual` differ from those of `expected` (both: path with `/` to bytes, as `filesOf` gives): one line for each file that is
 * missing, extra, or different, and for a different text file the first difference. Empty when they are the same. Use it as
 * `expect(differences(a, b)).toEqual([])`, so that a failure names the files.
 */
export function differences(actual: ReadonlyMap<string, Buffer>, expected: ReadonlyMap<string, Buffer>): string[] {
  const found: string[] = [];
  for (const [path, bytes] of expected) {
    const other = actual.get(path);
    if (other === undefined) found.push(`missing: ${path}`);
    else if (!other.equals(bytes)) found.push(`different: ${path}: ${firstDifference(other.toString("utf8"), bytes.toString("utf8"))}`);
  }
  const extra = [...actual.keys()].filter((path) => !expected.has(path));
  for (const path of extra) found.push(`extra: ${path}`);
  // A different SVG has a different hashed name, so it shows up as a missing and an extra file. Pair them by the alt text in their <title>
  // and show where each pair differs.
  const titleOf = (bytes: Buffer) => /<title id="diagram-title">([^<]*)<\/title>/.exec(bytes.toString("utf8"))?.[1] ?? "";
  const unpaired = extra.filter((path) => path.endsWith(".svg"));
  for (const path of [...expected.keys()].filter((name) => name.endsWith(".svg") && !actual.has(name))) {
    const expectedBytes = expected.get(path) as Buffer;
    const index = unpaired.findIndex((name) => titleOf(actual.get(name) as Buffer) === titleOf(expectedBytes));
    if (index === -1) continue;
    const [name] = unpaired.splice(index, 1) as [string];
    found.push(`compare ${name} with ${path} (title "${titleOf(expectedBytes)}"): ${firstDifference((actual.get(name) as Buffer).toString("utf8"), expectedBytes.toString("utf8"))}`);
  }
  return found;
}
