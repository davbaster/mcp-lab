// Checks the files in a course's assets/ folder, once per course, and keeps the allowed ones as they are written.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ASSET_TYPES, IMAGE_TYPES, MODEL_TYPES, VIDEO_EXTENSIONS, extensionOf, hashedName } from "./assets.ts";
import type { AssetType } from "./assets.ts";
import { listFolder } from "./folder.ts";
import type { Kind } from "./folder.ts";
import type { AssetLimits } from "./media-config.ts";
import type { Problem } from "./problem.ts";
import { svgProblems } from "./svg.ts";
import { compareText } from "./text.ts";
import { windowsPathProblems } from "./windows-paths.ts";

/** The longest path from assets/ (such as `images/pic.png`) that Windows must be able to extract. */
export const ASSET_PATH_LIMIT = 100;
const MAX_DEPTH = 32;
const NAME_RULE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** An allowed file, as it is written to the public build: text files are normalized (see `normalizeAssetText`). */
export type CheckedAsset = {
  /** The path from assets/, with `/`. */
  path: string;
  /** The flat hashed name: `<stem>-<first 16 hex digits of the SHA-256>.<ext>`. */
  file: string;
  /** The SHA-256 of `data`, in hex. */
  sha256: string;
  /** The size of `data` in bytes. */
  size: number;
  data: Uint8Array;
};

export type AssetCollector = {
  /** The course folder name, which is the `course_id` of the output. */
  courseId: string;
  /** The problems of the files in assets/ (errors only). */
  problems: Problem[];
  /** The files that have no problem (in content, name, or folder names), in path order. */
  files: CheckedAsset[];
  /** Every file, folder, and other entry found, by path from assets/ with `/`: where references are looked up. */
  entries: Map<string, Kind>;
};

export function makeAssetCollector(courseId: string): AssetCollector {
  return { courseId, problems: [], files: [], entries: new Map() };
}

/**
 * The text of a text asset as it is hashed and copied: one leading byte order mark removed, and `\r\n` and a
 * lone `\r` turned into `\n`.
 */
export function normalizeAssetText(text: string): string {
  return (text.startsWith("\uFEFF") ? text.slice(1) : text).replace(/\r\n?/g, "\n");
}

const MAGIC: Partial<Record<AssetType, { name: string; check: (bytes: Uint8Array) => boolean }>> = {
  png: { name: "a PNG", check: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  jpg: { name: "a JPEG", check: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  jpeg: { name: "a JPEG", check: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  webp: { name: "a WebP", check: (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b.subarray(8), [0x57, 0x45, 0x42, 0x50]) },
  glb: { name: "a binary glTF", check: (b) => startsWith(b, [0x67, 0x6c, 0x54, 0x46]) },
};

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, i) => bytes[i] === byte);
}

function limitFor(type: AssetType, limits: AssetLimits): number {
  if (IMAGE_TYPES.includes(type)) return limits.imageBytes;
  return MODEL_TYPES.includes(type) ? limits.modelBytes : limits.captionBytes;
}

function describeBytes(bytes: number): string {
  return bytes % 1048576 === 0 ? `${bytes} bytes (${bytes / 1048576} MiB)` : `${bytes} bytes`;
}

/**
 * Checks everything under `assetsDir` (the course's assets/ folder, or undefined when it has none) and
 * adds the problems and the allowed files to `collector`. Names are looked up in folder listings; a link
 * is reported and never followed.
 */
export function checkAssetFiles(assetsDir: string | undefined, limits: AssetLimits, collector: AssetCollector) {
  if (assetsDir === undefined) return;
  const error = (path: string, message: string, line?: number) =>
    collector.problems.push(line === undefined ? { severity: "error", file: `assets/${path}`, message } : { severity: "error", file: `assets/${path}`, line, message });

  const paths: string[] = [];
  walk(assetsDir, "", 1, collector, paths, error);
  paths.sort(compareText);

  const badNames = nameProblems(paths, error);

  for (const path of paths) {
    if (collector.entries.get(path) !== "file") continue;
    const checked = readAsset(join(assetsDir, ...path.split("/")), path, limits, error);
    // A file whose own name or folder name has a problem is reported, but not kept.
    const named = path.split("/").every((_, i, parts) => !badNames.has(parts.slice(0, i + 1).join("/")));
    if (checked !== undefined && named) collector.files.push(checked);
  }
  outputNameCollisions(collector, error);
}

function walk(
  folder: string,
  relative: string,
  depth: number,
  collector: AssetCollector,
  paths: string[],
  error: (path: string, message: string) => void,
) {
  const entries = listFolder(folder);
  if (entries === undefined) {
    error(relative, "the folder cannot be read");
    return;
  }
  for (const [name, kind] of entries) {
    const path = relative === "" ? name : `${relative}/${name}`;
    collector.entries.set(path, kind);
    if (kind === "directory") {
      if (depth >= MAX_DEPTH) error(path, `folders may be nested at most ${MAX_DEPTH} levels deep, so what is inside this folder is not checked`);
      else walk(join(folder, name), path, depth + 1, collector, paths, error);
      continue;
    }
    paths.push(path);
    if (kind === "other") error(path, "this is not a plain file or folder (for example, a symbolic link), and the build never follows links");
  }
}

/**
 * Names that Windows cannot extract, and names that a URL would need to encode. Each names the shortest path
 * that has the problem. `paths` are the file paths from assets/ with `/`; nothing is read from disk, so a test can
 * give it names that the local file system cannot create. Returns the paths that were reported.
 */
export function nameProblems(paths: string[], error: (path: string, message: string) => void): Set<string> {
  const reported = new Set<string>();
  for (const { path, message } of windowsPathProblems(paths, ASSET_PATH_LIMIT)) {
    error(path, message);
    reported.add(path);
  }
  const unsafe = new Set<string>();
  for (const path of paths) {
    let prefix = "";
    for (const name of path.split("/")) {
      prefix = prefix === "" ? name : `${prefix}/${name}`;
      if (NAME_RULE.test(name) || unsafe.has(prefix)) continue;
      unsafe.add(prefix);
      reported.add(prefix);
      error(prefix, "the name may use only letters, digits, `.`, `_`, and `-`, and may not start with `.`, so that a path never needs URL-encoding");
    }
  }
  return reported;
}

function readAsset(
  file: string,
  path: string,
  limits: AssetLimits,
  error: (path: string, message: string, line?: number) => void,
): CheckedAsset | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const extension = extensionOf(name);
  const type = ASSET_TYPES.find((allowed) => allowed === extension);
  if (type === undefined) {
    const allowed = `the allowed types are ${ASSET_TYPES.map((t) => `.${t}`).slice(0, -1).join(", ")}, and .${ASSET_TYPES[ASSET_TYPES.length - 1]}`;
    const video = VIDEO_EXTENSIONS.includes(extension)
      ? "; videos are not kept in assets/: put them on the media CDN and use them with `Video`"
      : "";
    error(path, `this file type is not allowed in assets/; ${allowed}${video}`);
    return undefined;
  }

  let size: number;
  try {
    size = lstatSync(file).size;
  } catch {
    error(path, "the file cannot be read");
    return undefined;
  }
  if (size === 0) {
    error(path, "the file is empty (0 bytes)");
    return undefined;
  }
  const limit = limitFor(type, limits);
  if (size > limit) {
    error(path, `the file is ${describeBytes(size)}, but the most allowed for a .${type} file is ${describeBytes(limit)}`);
    return undefined;
  }
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(file);
  } catch {
    error(path, "the file cannot be read");
    return undefined;
  }

  const magic = MAGIC[type];
  if (magic !== undefined) {
    if (magic.check(bytes)) return keep(path, name, bytes);
    error(path, `the file does not start like ${magic.name} file, so it is not one (for example, a video or a web page renamed to .${type})`);
    return undefined;
  }

  let text: string;
  try {
    text = normalizeAssetText(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    error(path, "the file is not valid UTF-8 text");
    return undefined;
  }
  const problems = textProblems(type, text);
  for (const problem of problems) error(path, problem.message, problem.line);
  return problems.length > 0 ? undefined : keep(path, name, new TextEncoder().encode(text));
}

function keep(path: string, name: string, data: Uint8Array): CheckedAsset {
  const sha256 = createHash("sha256").update(data).digest("hex");
  return { path, file: hashedName(name, sha256), sha256, size: data.length, data };
}

type TextProblem = { message: string; line?: number };

function textProblems(type: AssetType, text: string): TextProblem[] {
  if (type === "svg") return svgProblems(text);
  if (type === "vtt") {
    if (text.includes("\u0000")) return [{ message: "the file contains a NUL character, so it is not text" }];
    return text.startsWith("WEBVTT") ? [] : [{ message: "a .vtt file must start with `WEBVTT` (after an optional byte order mark)", line: 1 }];
  }
  return gltfProblems(text);
}

/** A .gltf must be UTF-8 JSON, and every `uri` in its `buffers` and `images` must be a `data:` URI. */
function gltfProblems(text: string): TextProblem[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [{ message: "a .gltf file must be JSON text, but this is not valid JSON" }];
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return [{ message: "a .gltf file must hold one JSON object" }];
  const root = json as Record<string, unknown>;
  for (const key of ["buffers", "images"]) {
    const list = root[key];
    if (!Array.isArray(list)) continue;
    for (const [index, item] of list.entries()) {
      const uri = typeof item === "object" && item !== null ? (item as Record<string, unknown>).uri : undefined;
      if (uri === undefined) continue;
      if (typeof uri === "string" && /^data:/i.test(uri)) continue;
      const shown = typeof uri === "string" && uri.length <= 80 ? ` \`${uri}\`` : "";
      return [{ message: `\`${key}[${index}]\` points to an outside file${shown}; embed it as a data: URI, or use a .glb file` }];
    }
  }
  return [];
}

/** The hashed names are written flat, so two names that differ only in letter case would be one file on Windows and macOS. */
function outputNameCollisions(collector: AssetCollector, error: (path: string, message: string) => void) {
  const first = new Map<string, CheckedAsset>();
  for (const asset of collector.files) {
    const key = asset.file.toLowerCase();
    const earlier = first.get(key);
    if (earlier === undefined) first.set(key, asset);
    else if (earlier.file !== asset.file) {
      error(asset.path, `its output name \`${asset.file}\` differs only in letter case from \`${earlier.file}\` (from ${earlier.path}), and Windows and macOS would keep only one; rename one of the files`);
    }
  }
}
