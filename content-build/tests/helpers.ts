import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import type { Problem } from "../src/problem.ts";

export const PART_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURES = join(PART_DIR, "fixtures");
export const VALID_COURSE = join(FIXTURES, "valid", "sample-course");
export const QUIZ_FIXTURES = join(FIXTURES, "quizzes");
/** The quiz of the first chapter of the valid course, the file that the single-file quiz fixtures replace. */
export const FIRST_QUIZ = "chapters/01-first-steps/quiz.yaml";
/**
 * The time limit for a test that starts Node two or more times, or builds all of `fixtures/invalid`. Vitest's default
 * of 5 s is enough on Linux (a start-up is 0.3 s), but on Windows each start-up takes 1 to 2.5 s and a build reads
 * about 100 fixture courses, so such a test can take longer than 5 s there.
 */
export const SLOW_PROCESS_TIMEOUT_MS = 30_000;

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
 * True when this file system can hold every one of these paths (with `/`) as separate files with exactly these names.
 * It tries: it creates them in a throwaway folder and looks the names up in the folder listings, so it is true on any
 * platform that can do it and false on one that cannot. (Windows refuses `a?b`; it makes `a:b` a stream of the file
 * `a`; and a case-insensitive file system makes `Step-1` and `step-1` one folder.)
 */
export function canCreate(...paths: string[]): boolean {
  const folder = mkdtempSync(join(tmpdir(), "content-build-probe-"));
  try {
    for (const path of paths) {
      const target = join(folder, ...path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "x");
    }
    return paths.every((path) => {
      let at = folder;
      return path.split("/").every((name) => {
        const found = readdirSync(at).includes(name);
        at = join(at, name);
        return found;
      });
    });
  } catch {
    return false;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * A copy of the valid fixture in a temporary folder named `id`, with `changes` applied. A key is a
 * path inside the course with `/` separators; a string or bytes value writes (or replaces) that file,
 * `null` deletes a file or folder. Text is written exactly as given, so a test can use CRLF and a BOM.
 */
export function makeCourse(id: string, changes: Record<string, string | Uint8Array | null> = {}): string {
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

/**
 * The text with `\n` line endings. A test that builds CRLF or CR text from a file it read calls this first, so that
 * it does not make `\r\r\n` from a checkout that already has CRLF.
 */
export function toLf(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

/** The text of a single-file quiz fixture, `fixtures/quizzes/<group>/<name>.yaml`, with `\n` line endings. */
export function quizFixture(group: "valid" | "invalid", name: string): string {
  return toLf(readFileSync(join(QUIZ_FIXTURES, group, `${name}.yaml`), "utf8"));
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

/** The chapters of the valid course, as `course.yaml` lists them. */
export const CHAPTERS = [
  { id: "01-first-steps", title: "First steps" },
  { id: "02-going-further", title: "Going further" },
];

/** A `chapters` list for `courseYaml` with these ids, each titled "Chapter <position>". */
export function chapterList(...ids: string[]): { id: string; title: string }[] {
  return ids.map((id, index) => ({ id, title: `Chapter ${index + 1}` }));
}

/**
 * A course.yaml written as JSON, which is YAML too: one key per line, and one chapter per line, so line numbers are
 * easy to count (`chapters` is on line 5, its items on lines 6, 7, ...).
 */
export function courseYaml(overrides: Record<string, unknown> = {}): string {
  const fields: Record<string, unknown> = {
    id: "sample-course",
    title: "Sample course",
    description: "A small course.",
    chapters: CHAPTERS,
    free_preview: ["01-first-steps"],
    ...overrides,
  };
  const entries = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const text =
        key === "chapters" && Array.isArray(value) && value.length > 0
          ? `[\n${value.map((item) => `  ${JSON.stringify(item)}`).join(",\n")}\n ]`
          : JSON.stringify(value, null, 1).replaceAll("\n", "\n ");
      return ` ${JSON.stringify(key)}: ${text}`;
    });
  return `{\n${entries.join(",\n")}\n}\n`;
}

/** The code folder of the first chapter of the valid course. */
export const CODE = "chapters/01-first-steps/code";

/**
 * A copy of the valid fixture whose first chapter has exactly the code `files` (a path inside code/ with
 * `/`, to its content) instead of the fixture's three steps. `changes` are applied after, as in `makeCourse`.
 */
export function codeCourse(files: Record<string, string | Uint8Array>, changes: Record<string, string | Uint8Array | null> = {}): string {
  const inCode = Object.fromEntries(Object.entries(files).map(([path, content]) => [`${CODE}/${path}`, content]));
  return makeCourse("sample-course", { [CODE]: null, ...inCode, ...changes });
}

export const LESSON_FIXTURES = join(FIXTURES, "lessons");
/** The small schema folder that the rule tests use, so they do not change when a real component schema does. */
export const COMPONENT_FIXTURES = join(FIXTURES, "components");
/** The real component schemas, which the golden trees and one shape test use. */
export const REAL_SCHEMAS = join(PART_DIR, "..", "frontend", "src", "content-components", "schemas");

/** A problem of a lesson: always an error, with a line and a column. */
export function lessonProblem(file: string, line: number, column: number, message: string): Problem {
  return { severity: "error", file, line, column, message };
}
