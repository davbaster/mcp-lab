// Shared by the tests of the build and of the ID check: running the commands, and reading a folder as a record.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { main as build } from "../src/build-cli.ts";
import type { BuildOptions } from "../src/build-cli.ts";
import { checkMain, updateMain } from "../src/ids-cli.ts";
import { FIXTURES, VALID_COURSE, temporaryFolder } from "./helpers.ts";

export type Run = { code: number; stdout: string; stderr: string };

export async function runBuild(args: string[], options: BuildOptions = {}): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const code = await build(args, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) }, { env: {}, ...options });
  return { code, stdout, stderr };
}

export function runIds(command: "update" | "check", args: string[]): Run {
  let stdout = "";
  let stderr = "";
  const main = command === "update" ? updateMain : checkMain;
  const code = main(args, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) });
  return { code, stdout, stderr };
}

/** The courses folder of the valid fixture: `fixtures/valid`, which holds one course. */
export const VALID_COURSES = join(FIXTURES, "valid");

/** A path for a build folder that does not exist yet. */
export function newBuildFolder(): string {
  return join(temporaryFolder(), "build");
}

/** Every file under `folder` by its path with `/`, mapped to its bytes. A missing folder is empty. */
export function filesOf(folder: string, prefix = ""): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  if (!existsSync(folder)) return found;
  for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) for (const [name, bytes] of filesOf(join(folder, entry.name), path)) found.set(name, bytes);
    else found.set(path, readFileSync(join(folder, entry.name)));
  }
  return found;
}

/** Every folder under `folder` by its path with `/`, including empty ones. */
export function foldersOf(folder: string, prefix = ""): string[] {
  const found: string[] = [];
  if (!existsSync(folder)) return found;
  for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue;
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    found.push(path, ...foldersOf(join(folder, entry.name), path));
  }
  return found;
}

/** A comparable record of a folder: path to hex of the bytes, and the folders. */
export function snapshotOf(folder: string): { files: Record<string, string>; folders: string[] } {
  return {
    files: Object.fromEntries([...filesOf(folder)].map(([path, bytes]) => [path, bytes.toString("hex")])),
    folders: foldersOf(folder),
  };
}

/**
 * A courses folder in a temporary folder with one copy of the valid course per id. `changes` per id are applied as in
 * `makeCourse` (a path inside the course to its new content, or null to delete it). Returns the courses folder.
 */
export function coursesFolder(courses: Record<string, Record<string, string | Uint8Array | null>> = { "sample-course": {} }): string {
  const folder = join(temporaryFolder(), "courses");
  mkdirSync(folder);
  for (const [id, changes] of Object.entries(courses)) {
    const course = join(folder, id);
    cpSync(VALID_COURSE, course, { recursive: true });
    writeFileSync(join(course, "course.yaml"), readFileSync(join(course, "course.yaml"), "utf8").replace("id: sample-course", `id: ${id}`));
    for (const [path, content] of Object.entries(changes)) {
      const target = join(course, ...path.split("/"));
      if (content === null) {
        rmSync(target, { recursive: true, force: true });
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
    }
  }
  return folder;
}
