// Reading folders and files so that names are exactly as they appear on disk.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { toPosix } from "./problem.ts";

export type Kind = "file" | "directory" | "other";

/** Files that operating systems add. They are ignored without a warning. */
const OS_FILES = new Set([".DS_Store", "Thumbs.db"]);

/**
 * The entries of a folder by their exact on-disk names, sorted, without OS files. Looking a name up
 * here (never asking the file system to open it) keeps `01-Tools` from matching `01-tools` on
 * Windows and macOS, whose file systems ignore case. Returns undefined when the folder cannot be read.
 */
export function listFolder(folder: string): Map<string, Kind> | undefined {
  try {
    const entries = readdirSync(folder, { withFileTypes: true });
    const kinds = entries
      .filter((entry) => !OS_FILES.has(entry.name))
      .map((entry): [string, Kind] => [
        entry.name,
        entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
      ]);
    return new Map(kinds.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  } catch {
    return undefined;
  }
}

export type Text = { text: string } | { error: string };

/** Reads a UTF-8 file. An unreadable file or bytes that are not UTF-8 come back as an error message. */
export function readText(file: string): Text {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(file)) };
  } catch (error) {
    if (error instanceof TypeError) return { error: "the file is not valid UTF-8" };
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown error";
    return { error: `the file cannot be read (${code})` };
  }
}

/**
 * Turns the path the user typed into an absolute path. Both `/` and `\` separate folders on every
 * platform, so `fixtures\valid\sample` works on Linux too.
 */
export function resolveCoursePath(typed: string): string {
  return resolve(toPosix(typed) || ".");
}

export function pathKind(path: string): Kind | undefined {
  try {
    const stats = statSync(path);
    return stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other";
  } catch {
    return undefined;
  }
}

/** The name of a folder as it is spelled on disk, which may differ in case from the way it was typed. */
export function onDiskName(folder: string): string {
  const typed = basename(folder);
  const parent = dirname(folder);
  if (parent === folder) return typed;
  const siblings = listFolder(parent);
  if (siblings === undefined || siblings.has(typed)) return typed;
  return [...siblings.keys()].find((name) => name.toLowerCase() === typed.toLowerCase()) ?? typed;
}
