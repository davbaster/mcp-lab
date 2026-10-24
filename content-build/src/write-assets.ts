// Writes the allowed assets of a course to the public build folder under content-hashed names, and the map
// from each original path to its hashed name. Nothing is written under `private/`, and the map is not served.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CheckedAsset } from "./asset-files.ts";
import { inspectCourse } from "./course.ts";
import { sortProblems } from "./problem.ts";
import type { Problem } from "./problem.ts";
import { compareText } from "./text.ts";

/** The content of `<buildDir>/assets-map/<course_id>.json`, with the keys in the order they are written. */
export type AssetMapJson = {
  course_id: string;
  files: Record<string, { file: string; sha256: string; size: number }>;
};

/** The map of the checked files: keys in code-unit order, each entry built by listing its fields. */
export function buildAssetMap(courseId: string, files: readonly CheckedAsset[]): AssetMapJson {
  const entries = [...files].sort((a, b) => compareText(a.path, b.path));
  return {
    course_id: courseId,
    files: Object.fromEntries(entries.map(({ path, file, sha256, size }) => [path, { file, sha256, size }])),
  };
}

/**
 * Checks the files in assets/ of the course at `courseDir`. If none has a problem, writes each one flat, as
 * `<buildDir>/public/assets/<course_id>/<stem>-<hash>.<ext>`, and the map to `<buildDir>/assets-map/<course_id>.json`,
 * and returns an empty list. Otherwise it writes nothing, leaves the build folder as it was, and returns the
 * problems. Everything is prepared in memory before the first file is written. Before writing, it removes
 * `<buildDir>/public/assets/<course_id>/` and the old map (and only those), so no file of a removed asset stays.
 * It never reads, writes, or removes anything under `<buildDir>/private/`.
 *
 * It does not check the lessons; run `validateCourse` first.
 */
export function writeAssets(courseDir: string, buildDir: string): Problem[] {
  if (buildDir.trim() === "") throw new Error("writeAssets needs the build folder");
  const { problems, assets } = inspectCourse(courseDir);
  if (assets === undefined) return problems;
  if (!/^[a-z0-9-]+$/.test(assets.courseId)) {
    return [{ severity: "error", file: "", message: "the course folder name must use only lowercase letters, digits, and hyphens" }];
  }
  if (assets.problems.length > 0) return sortProblems(assets.problems);

  const root = resolve(buildDir);
  const folder = join(root, "public", "assets", assets.courseId);
  const mapFile = join(root, "assets-map", `${assets.courseId}.json`);
  // JSON.stringify indents with "\n", never the platform's line ending, and keeps non-ASCII text as it is.
  const map = `${JSON.stringify(buildAssetMap(assets.courseId, assets.files), null, 2)}\n`;

  rmSync(folder, { recursive: true, force: true });
  rmSync(mapFile, { force: true });
  if (assets.files.length > 0) {
    mkdirSync(folder, { recursive: true });
    // Identical bytes and the same stem give the same name, so the file is written once.
    for (const { file, data } of assets.files) writeFileSync(join(folder, file), data);
  }
  mkdirSync(join(root, "assets-map"), { recursive: true });
  writeFileSync(mapFile, map, "utf8");
  return [];
}
