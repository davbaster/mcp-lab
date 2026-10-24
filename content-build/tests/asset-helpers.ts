// Shared by the asset tests: courses with exactly the assets a test names, and a media config with other limits.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lessonText, makeCourse, temporaryFolder, VALID_COURSE } from "./helpers.ts";
import type { Problem } from "../src/problem.ts";

/** The lesson of the valid course that uses the fixture's assets. A test that does not want them replaces it. */
export const NEXT = "chapters/02-going-further/lessons/01-next.mdx";

/** The bytes of the fixture's real small assets, by path from assets/. */
export function fixtureAsset(path: string): Buffer {
  return readFileSync(join(VALID_COURSE, "assets", ...path.split("/")));
}

export const PNG = fixtureAsset("images/pic.png");
export const JPG = fixtureAsset("images/photo.jpg");
export const WEBP = fixtureAsset("images/banner.webp");
export const GLB = fixtureAsset("models/server.glb");
export const GLTF = fixtureAsset("models/box.gltf").toString("utf8");
export const VTT = fixtureAsset("captions/intro.vtt").toString("utf8");
export const SVG = fixtureAsset("images/logo.svg").toString("utf8");

/** A lesson file whose body starts on line 8, column 1 (the same layout as the lesson fixtures). */
export function lessonWith(body: string, order = 1): string {
  return `---\ntitle: Next steps\norder: ${order}\n---\n\n# Next steps\n\n${body}\n`;
}

/**
 * A copy of the valid course whose assets/ holds exactly `assets` (path from assets/ to content) and whose
 * `01-next.mdx` is `lesson` (a plain lesson that uses nothing by default). `changes` are applied last.
 */
export function assetCourse(
  assets: Record<string, string | Uint8Array>,
  lesson: string = lessonText("Next steps", 1),
  changes: Record<string, string | Uint8Array | null> = {},
): string {
  const files = Object.fromEntries(Object.entries(assets).map(([path, content]) => [`assets/${path}`, content]));
  return makeCourse("sample-course", { assets: null, [NEXT]: lesson, ...files, ...changes });
}

export const errorsOf = (problems: readonly Problem[]) => problems.filter((problem) => problem.severity === "error");

/** `file: message` lines of the errors, which read well in a failed comparison. */
export function lines(problems: readonly Problem[]): string[] {
  return problems.map((p) => `${p.severity} ${p.file}${p.line === undefined ? "" : `:${p.line}${p.column === undefined ? "" : `:${p.column}`}`} ${p.message}`);
}

/** The committed media config with `changes` merged over the top level, written to a temporary file. */
export function mediaConfigFile(changes: Record<string, unknown> = {}, name = "media-config.json"): string {
  const base = JSON.parse(readFileSync(join(VALID_COURSE, "..", "..", "..", "media-config.json"), "utf8")) as Record<string, unknown>;
  const path = join(temporaryFolder(), name);
  writeFileSync(path, `${JSON.stringify({ ...base, ...changes }, null, 2)}\n`);
  return path;
}
