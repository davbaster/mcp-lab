// Writes the manifest and the lesson trees of a course to the private build folder, which only the backend reads.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildAssetMap } from "./write-assets.ts";
import type { Inspection } from "./course.ts";
import type { LessonTree } from "./lesson-tree.ts";
import { rewriteAssetUrls } from "./rewrite-assets.ts";

/** The version of the manifest and the lesson files. A change to their shape raises it. */
export const SCHEMA_VERSION = 1;

/** The content of `<buildDir>/private/courses/<course_id>.json`, with the keys in the order they are written. */
export type CourseManifestJson = {
  schema_version: typeof SCHEMA_VERSION;
  course_id: string;
  title: string;
  description: string;
  chapters: {
    id: string;
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
  return {
    schema_version: SCHEMA_VERSION,
    course_id: courseId,
    title: course.title,
    description: course.description,
    chapters: chapters.map((id) => ({
      id,
      free_preview: course.freePreview.includes(id),
      has_code: code.chapters.some((chapter) => chapter.chapter_id === id),
      lessons: lessons.filter((lesson) => lesson.chapter_id === id).map(({ id: lessonId, title, order }) => ({ id: lessonId, title, order })),
    })),
  };
}

/**
 * Writes `private/courses/<course_id>.json` and `private/lessons/<course_id>/<lesson_id>.json` for a course
 * that has no error. Each lesson tree has its asset references pointed at the hashed files (see
 * `rewriteAssetUrls`). The caller has removed the old output; this only adds files. Returns false, and
 * writes nothing, when the inspection lacks what the files need.
 */
export function writeCourse(courseId: string, inspection: Inspection, buildDir: string): boolean {
  const manifest = buildManifest(courseId, inspection);
  const { lessons, assets } = inspection;
  if (manifest === undefined || lessons === undefined || assets === undefined) return false;

  const assetMap = buildAssetMap(courseId, assets.files).files;
  const root = resolve(buildDir);
  const lessonFolder = join(root, "private", "lessons", courseId);
  mkdirSync(lessonFolder, { recursive: true });
  for (const lesson of lessons) {
    // Each object is built by listing its fields, so nothing else reaches the file.
    const json: LessonJson = {
      course_id: courseId,
      chapter_id: lesson.chapter_id,
      lesson_id: lesson.id,
      tree: rewriteAssetUrls(lesson.tree, courseId, assetMap),
    };
    writeFileSync(join(lessonFolder, `${lesson.id}.json`), jsonText(json), "utf8");
  }
  mkdirSync(join(root, "private", "courses"), { recursive: true });
  writeFileSync(join(root, "private", "courses", `${courseId}.json`), jsonText(manifest), "utf8");
  return true;
}
