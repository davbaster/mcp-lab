// Regenerates `fixtures/expected-mermaid/` with the real renderer. Run it after Mermaid, Chromium, `mermaid-config.json`, or the
// post-processing changes on purpose (see "Diagrams" in README.md), and read the diff before you commit it:
//
//   cd content-build
//   node tests/update-mermaid-goldens.ts
//
// It writes `renderer/<type>.svg` (what the renderer returns for the one diagram of each type in the types lesson) and `build/` (the
// build folder of building `fixtures/mermaid`). It is not a test and it is not run by `npm test`.

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main as build } from "../src/build-cli.ts";
import { inspectCourse } from "../src/course.ts";
import { diagramType } from "../src/diagram-source.ts";
import { loadMermaidConfig } from "../src/mermaid-config.ts";
import { createMermaidRenderer } from "../src/mermaid-render.ts";

const PART_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const COURSES = join(PART_DIR, "fixtures", "mermaid");
const GOLDEN = join(PART_DIR, "fixtures", "expected-mermaid");
const TYPES_LESSON = "chapters/01-diagram-types/lessons/01-types.mdx";

const lesson = inspectCourse(join(COURSES, "mermaid-course"), { compileLessons: true }).lessons?.find((candidate) => candidate.file === TYPES_LESSON);
if (lesson === undefined) throw new Error("the types lesson did not compile");

rmSync(GOLDEN, { recursive: true, force: true });
mkdirSync(join(GOLDEN, "renderer"), { recursive: true });

const renderer = await createMermaidRenderer(loadMermaidConfig());
try {
  for (const use of lesson.diagrams) {
    const type = diagramType(use.source)?.type;
    if (type === undefined) throw new Error("a diagram of the types lesson has no type");
    writeFileSync(join(GOLDEN, "renderer", `${type}.svg`), await renderer.render(use.source));
  }
} finally {
  await renderer.close();
}

// The build runs in a temporary folder with an empty cache, so the golden never depends on what the cache holds.
const work = mkdtempSync(join(tmpdir(), "mermaid-golden-"));
try {
  const out = join(work, "build");
  let output = "";
  const code = await build([COURSES, out], { stdout: (text) => (output += text), stderr: (text) => (output += text) }, { env: {}, cacheDir: join(work, "cache") });
  if (code !== 0) throw new Error(`the build of fixtures/mermaid failed:\n${output}`);
  cpSync(out, join(GOLDEN, "build"), { recursive: true });
} finally {
  rmSync(work, { recursive: true, force: true });
}
