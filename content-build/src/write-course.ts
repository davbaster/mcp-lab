// Writes the manifest and the lesson trees of a course to the private build folder, which only the backend reads.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildAssetMap } from "./write-assets.ts";
import type { Inspection } from "./course.ts";
import type { CourseDiagrams } from "./diagrams.ts";
import type { LessonTree } from "./lesson-tree.ts";
import { hasMermaidSource, rewriteAssetUrls } from "./rewrite-assets.ts";

/** The version of the manifest and the lesson files. A change to their shape raises it. */
export const SCHEMA_VERSION = 2;

/** The content of `<buildDir>/private/courses/<course_id>.json`, with the keys in the order they are written. */
export type CourseManifestJson = {
  schema_version: typeof SCHEMA_VERSION;
  course_id: string;
  title: string;
  description: string;
  chapters: {
    id: string;
    /** The chapter's `title` in `course.yaml`, trimmed: not empty, one line, at most 100 characters. */
    title: string;
    free_preview: boolean;
    /** Whether `private/code/<course_id>/<chapter_id>.json` exists. */
    has_code: boolean;
    lessons: { id: string; title: string; order: number }[];
  }[];
};

/** The content of `<buildDir>/private/lessons/<course_id>/<lesson_id>.json`. */
export type LessonJson = { course_id: string; chapter_id: string; lesson_id: string; tree: LessonTree };

/** JSON as every build file is written: UTF-8, LF, a 2-space indent, and a final newline (`JSON.stringify` indents with `\n` on every platform and keeps non-ASCII text). */
export function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The manifest of a checked course, or undefined when the check did not find everything it needs (the course has errors). */
export function buildManifest(courseId: string, inspection: Inspection): CourseManifestJson | undefined {
  const { course, chapters, lessons, code } = inspection;
  if (course === undefined || chapters === undefined || lessons === undefined || code === undefined) return undefined;
  const titles = chapters.map((id) => course.chapterTitles.get(id));
  if (titles.some((title) => title === undefined)) return undefined;
  return {
    schema_version: SCHEMA_VERSION,
    course_id: courseId,
    title: course.title,
    description: course.description,
    chapters: chapters.map((id, index) => ({
      id,
      title: titles[index] as string,
      free_preview: course.freePreview.includes(id),
      has_code: code.chapters.some((chapter) => chapter.chapter_id === id),
      lessons: lessons.filter((lesson) => lesson.chapter_id === id).map(({ id: lessonId, title, order }) => ({ id: lessonId, title, order })),
    })),
  };
}

/**
 * Writes `private/courses/<course_id>.json` and `private/lessons/<course_id>/<lesson_id>.json` for a course
 * that has no error. Each lesson tree has its asset references pointed at the hashed files (see
 * `rewriteAssetUrls`), and each `Diagram` that had Mermaid `source` points at its rendered file (`diagrams`). The caller has
 * removed the old output; this only adds files. Returns false, and writes nothing, when the inspection lacks what the files need.
 */
export function writeCourse(courseId: string, inspection: Inspection, buildDir: string, diagrams?: CourseDiagrams): boolean {
  const manifest = buildManifest(courseId, inspection);
  const { lessons, assets } = inspection;
  if (manifest === undefined || lessons === undefined || assets === undefined) return false;

  const assetMap = buildAssetMap(courseId, assets.files, diagrams?.svgs).files;
  const root = resolve(buildDir);
  const lessonFolder = join(root, "private", "lessons", courseId);
  mkdirSync(lessonFolder, { recursive: true });
  for (const lesson of lessons) {
    const tree = rewriteAssetUrls(lesson.tree, courseId, assetMap, diagrams?.fileFor);
    // Fail closed: the Mermaid text is never written, so a Diagram that kept its `source` (no rendered diagrams were given) stops the build.
    if (hasMermaidSource(tree)) throw new Error(`internal error: the lesson \`${lesson.id}\` still has a Diagram with Mermaid source, which must not be written; its diagrams were not rendered`);
    // Each object is built by listing its fields, so nothing else reaches the file.
    const json: LessonJson = { course_id: courseId, chapter_id: lesson.chapter_id, lesson_id: lesson.id, tree };
    writeFileSync(join(lessonFolder, `${lesson.id}.json`), jsonText(json), "utf8");
  }
  mkdirSync(join(root, "private", "courses"), { recursive: true });
  writeFileSync(join(root, "private", "courses", `${courseId}.json`), jsonText(manifest), "utf8");
  return true;
}
