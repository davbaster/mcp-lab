// Turns the `Diagram` sources of the checked courses into SVG files: cache first, then one browser for the rest, then the SVG
// rules and the size limit. It writes nothing to the build folder; `writeAssets` writes the files, so that the build stays all or nothing.

import { createHash } from "node:crypto";
import { diagramSourceProblems, normalizeSource, sourceLineOfMermaidLine, sourcePosition } from "./diagram-source.ts";
import { finishSvg, labelSvg } from "./diagram-svg.ts";
import { hashedName } from "./assets.ts";
import { describeBytes } from "./asset-files.ts";
import type { CheckedCourse } from "./courses-folder.ts";
import type { DiagramUse } from "./lesson.ts";
import { loadMediaConfig } from "./media-config.ts";
import { SvgCache, cacheDirectory, cacheKey } from "./mermaid-cache.ts";
import { loadMermaidConfig } from "./mermaid-config.ts";
import { DiagramRenderError, createMermaidRenderer } from "./mermaid-render.ts";
import type { DiagramRenderer, RenderErrorKind, RendererFactory } from "./mermaid-render.ts";
import { installedVersions } from "./mermaid-versions.ts";
import type { RenderVersions } from "./mermaid-versions.ts";
import type { Problem } from "./problem.ts";
import { svgProblems } from "./svg.ts";

export type DiagramOptions = {
  /** Starts the renderer. Defaults to the real one (Chromium). It is called once, and only when a diagram is not in the cache. */
  rendererFactory?: RendererFactory;
  /** The cache folder. Defaults to `MERMAID_CACHE_DIR`, else `content-build/.cache/mermaid/`. */
  cacheDir?: string;
  /** The environment, for `MERMAID_CACHE_DIR`. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** The Mermaid config to use instead of the committed `mermaid-config.json`. */
  mermaidConfigPath?: string;
  /** The media config to use instead of the committed `media-config.json`. */
  mediaConfigPath?: string;
  /** The versions that go into the cache key. Defaults to the installed ones. */
  versions?: RenderVersions;
};

/** A rendered diagram as `writeAssets` writes it. */
export type GeneratedSvg = {
  /** The key in `assets-map/<course_id>.json`. It has a `:`, which no file in assets/ can have. */
  key: string;
  /** The flat hashed name: `diagram-<first 16 hex digits of the SHA-256>.svg`. */
  file: string;
  sha256: string;
  size: number;
  data: Uint8Array;
};

/** What the diagrams of one course came to. */
export type CourseDiagrams = {
  /** The files to write, one per distinct output, in key order. */
  svgs: GeneratedSvg[];
  /** The hashed file name of the diagram with this source and `alt`, or undefined when it has none (it had a problem). */
  fileFor(source: string, alt: string): string | undefined;
  /** The problems of the diagrams of this course, in lesson order. */
  problems: Problem[];
};

type Use = { course: CheckedCourse; file: string; use: DiagramUse };

/** The `Diagram` uses of the courses, in course order, lesson order, and the order in the lesson. */
function usesOf(courses: readonly CheckedCourse[]): Use[] {
  return courses.flatMap((course) =>
    (course.inspection.lessons ?? []).flatMap((lesson) => lesson.diagrams.map((use) => ({ course, file: lesson.file, use }))),
  );
}

/** Why a source was not drawn: what the renderer says (`mermaid`, `timeout`, `crash`), or that the SVG it wrote is not allowed (`svg`). */
type DrawError = { kind: RenderErrorKind | "svg"; message: string };

/** What drawing one source gave: the SVG (before the accessible name), or why not. */
type Drawn = { svg: string } | { error: DrawError };

/** A message of `svgProblems` told for a diagram that Mermaid drew: the author cannot remove anything from the SVG. */
function renderedProblem(message: string): string {
  return `the diagram that Mermaid drew breaks an SVG rule, so it is not written (the problem is in the rendered diagram, not in the lesson text): ${message.replace(/;\s*remove it$/, "")}`;
}

/**
 * Renders the `Diagram` sources of the compiled lessons of `courses` and returns, for each course (by id), the files and the
 * problems. A source with a problem found without drawing (`diagramSourceProblems`) is skipped; `validate` reports it.
 * A `SetupError` (the config is not valid, the browser is not installed) is thrown.
 *
 * Chromium starts once, when the first source is not in the cache, and not at all when every source is.
 */
export async function renderDiagrams(courses: readonly CheckedCourse[], options: DiagramOptions = {}): Promise<Map<string, CourseDiagrams>> {
  const results = new Map<string, CourseDiagrams>();
  const all = usesOf(courses);
  const wanted = all.filter(({ use }) => diagramSourceProblems(use.source).length === 0);
  const drawn = new Map<string, Drawn>();

  if (wanted.length > 0) {
    const env = options.env ?? process.env;
    const config = loadMermaidConfig(options.mermaidConfigPath);
    const versions = options.versions ?? (await installedVersions());
    const cache = new SvgCache(cacheDirectory(env, options.cacheDir));
    const keyOf = (source: string) => cacheKey({ source, config: config.bytes, ...versions });

    const missing: string[] = [];
    for (const { use } of wanted) {
      const source = normalizeSource(use.source);
      if (drawn.has(source) || missing.includes(source)) continue;
      const cached = cache.read(keyOf(source));
      // An entry must be what finishSvg writes; one that is not (an old or edited file) is drawn again.
      const finished = cached === undefined ? undefined : finishSvg(cached);
      if (cached !== undefined && finished !== undefined && "svg" in finished && finished.svg === cached) drawn.set(source, { svg: cached });
      else missing.push(source);
    }

    if (missing.length > 0) {
      const renderer = await (options.rendererFactory ?? createMermaidRenderer)(config);
      try {
        for (const source of missing) drawn.set(source, await draw(renderer, source, (svg) => cache.write(keyOf(source), svg)));
      } finally {
        await renderer.close();
      }
    }
  }

  const imageBytes = wanted.length > 0 ? loadMediaConfig(options.mediaConfigPath).assetLimits.imageBytes : 0;
  for (const course of courses) {
    const files = new Map<string, GeneratedSvg>();
    const lookup = new Map<string, string>();
    const problems: Problem[] = [];
    for (const { file, use } of all.filter((entry) => entry.course === course)) {
      const tag = { line: use.tagLine, column: use.tagColumn };
      const fail = (message: string, at: { line: number; column: number } = tag) => problems.push({ severity: "error", file, ...at, message });
      const source = normalizeSource(use.source);
      const result = drawn.get(source);
      if (result === undefined) continue; // it had a problem that validate reports
      if ("error" in result) {
        const { error } = result;
        if (error.kind !== "mermaid") {
          fail(error.message);
        } else {
          // Mermaid counts lines in the text it parses; the position is the line of the lesson that this line came from.
          const named = /\bon line (\d+)/.exec(error.message)?.[1];
          const at = named === undefined ? { line: use.line, column: use.column } : sourcePosition(use, sourceLineOfMermaidLine(source, Number(named)));
          fail(`Mermaid could not parse this diagram: ${error.message}`, at);
        }
        continue;
      }
      const svg = labelSvg(result.svg, use.alt);
      const rule = svgProblems(svg)[0];
      if (rule !== undefined) {
        fail(renderedProblem(rule.message));
        continue;
      }
      const data = new TextEncoder().encode(svg);
      if (data.length > imageBytes) {
        fail(`the rendered diagram is ${describeBytes(data.length)}, but the most allowed for an image file is ${describeBytes(imageBytes)}`);
        continue;
      }
      const sha256 = createHash("sha256").update(data).digest("hex");
      const name = hashedName("diagram.svg", sha256);
      if (!files.has(name)) files.set(name, { key: `mermaid:${sha256.slice(0, 16)}.svg`, file: name, sha256, size: data.length, data });
      lookup.set(lookupKey(source, use.alt), name);
    }
    results.set(course.id, {
      svgs: [...files.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
      fileFor: (source, alt) => lookup.get(lookupKey(normalizeSource(source), alt)),
      problems,
    });
  }
  return results;
}

function lookupKey(source: string, alt: string): string {
  return JSON.stringify([source, alt]);
}

/** Draws one source and checks what came back. A good SVG is handed to `keep` (the cache) before it is returned. */
async function draw(renderer: DiagramRenderer, source: string, keep: (svg: string) => void): Promise<Drawn> {
  try {
    const finished = finishSvg(await renderer.render(source));
    if ("problem" in finished) return { error: { kind: "svg", message: finished.problem } };
    const rule = svgProblems(finished.svg)[0];
    if (rule !== undefined) return { error: { kind: "svg", message: renderedProblem(rule.message) } };
    keep(finished.svg);
    return { svg: finished.svg };
  } catch (error) {
    if (error instanceof DiagramRenderError) return { error: { kind: error.kind, message: error.message } };
    throw error;
  }
}
