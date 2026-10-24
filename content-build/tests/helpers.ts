import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import type { Problem } from "../src/problem.ts";

export const PART_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURES = join(PART_DIR, "fixtures");
export const VALID_COURSE = join(FIXTURES, "valid", "sample-course");

const temporaryFolders: string[] = [];

afterEach(() => {
  for (const folder of temporaryFolders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** An empty folder that is removed after the test. */
export function temporaryFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "content-build-"));
  temporaryFolders.push(folder);
  return folder;
}

/**
 * A copy of the valid fixture in a temporary folder named `id`, with `changes` applied. A key is a
 * path inside the course with `/` separators; a string value writes (or replaces) that file, `null`
 * deletes a file or folder. Text is written exactly as given, so a test can use CRLF and a BOM.
 */
export function makeCourse(id: string, changes: Record<string, string | null> = {}): string {
  const course = join(temporaryFolder(), id);
  cpSync(VALID_COURSE, course, { recursive: true });
  for (const [path, content] of Object.entries(changes)) {
    const target = join(course, ...path.split("/"));
    if (content === null) {
      rmSync(target, { recursive: true, force: true });
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }
  return course;
}

export function lessonText(title: string, order: number | string, extra = ""): string {
  return `---\ntitle: ${title}\norder: ${order}\n${extra}---\n\n# ${title}\n`;
}

export function error(file: string, message: string, line?: number): Problem {
  return line === undefined ? { severity: "error", file, message } : { severity: "error", file, line, message };
}

export function warning(file: string, message: string, line?: number): Problem {
  return line === undefined ? { severity: "warning", file, message } : { severity: "warning", file, line, message };
}

/** A course.yaml written as JSON, which is YAML too: one key per line, so line numbers are easy to count. */
export function courseYaml(overrides: Record<string, unknown> = {}): string {
  const fields: Record<string, unknown> = {
    id: "sample-course",
    title: "Sample course",
    description: "A small course.",
    chapters: ["01-first-steps", "02-going-further"],
    free_preview: ["01-first-steps"],
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) if (value === undefined) delete fields[key];
  return `${JSON.stringify(fields, null, 1)}\n`;
}
