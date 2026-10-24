// The notes about the build and the stable IDs in the READMEs stay true.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PART_DIR } from "./helpers.ts";
import { VALID_COURSES, newBuildFolder, runBuild } from "./build-support.ts";

const ROOT = join(PART_DIR, "..");
const README = readFileSync(join(PART_DIR, "README.md"), "utf8");
const COURSES_README = readFileSync(join(ROOT, "courses", "README.md"), "utf8");
const ROOT_README = readFileSync(join(ROOT, "README.md"), "utf8");
const AGENTS = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
const building = /^## Building the courses$([\s\S]*?)^## Stable IDs$/m.exec(README)?.[1] ?? "";
const stable = /^## Stable IDs$([\s\S]*?)^## Layout$/m.exec(README)?.[1] ?? "";

describe("content-build/README.md", () => {
  it("documents the build command, COURSES, the all-or-nothing rule, the exit codes, and the last line", () => {
    for (const text of [
      "npm run build -- <courses folder> <build folder>",
      "`COURSES`",
      "All or nothing.",
      "exits 2",
      "built <n> course(s) into <build folder>",
      "no courses found in <folder>",
      "`<build>/private/`, `<build>/public/`, and `<build>/assets-map/`",
      "byte-identical",
    ]) {
      expect(building, text).toContain(text);
    }
  });

  it("shows the layout of the build folder and the keys of the manifest as the build writes them", async () => {
    for (const path of ["courses/<course_id>.json", "lessons/<course_id>/<lesson_id>.json", "quizzes/<course_id>/<chapter_id>.json", "code/<course_id>/<chapter_id>.json", "assets/<course_id>/", "assets-map/<course_id>.json"]) {
      expect(building, path).toContain(path);
    }
    const build = newBuildFolder();
    expect((await runBuild([VALID_COURSES, build])).code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(build, "private", "courses", "sample-course.json"), "utf8")) as Record<string, unknown>;
    for (const key of [...Object.keys(manifest), "id", "free_preview", "has_code", "lessons", "order"]) expect(building, key).toContain(`"${key}"`);
    expect(building).toContain("COURSE_BUILD_DIR");
    expect(building).toContain("[#103]");
  });

  it("documents the new checks, the ids commands, the note format, and the CI base", () => {
    for (const text of ["Windows device name", "`CodeSteps` tag names a real step and file", "`codeSteps`"]) expect(building, text).toContain(text);
    for (const text of [
      "npm run ids:update -- <courses folder>",
      "npm run ids:check -- <courses folder>",
      "--base <git ref>",
      "run npm run ids:update",
      "removed <kind> <id>: <reason>",
      "`git merge-base <ref> HEAD`",
      "fetch more history",
      "only of zeros",
      "fetch-depth: 0",
      "`github.event.before`",
      "`origin/main`",
      "v1 does not remove courses",
    ]) {
      expect(stable, text).toContain(text);
    }
  });
});

describe("the other READMEs", () => {
  it("courses/README.md explains ids.json, MIGRATIONS.md, and the course-wide lesson ID rule", () => {
    for (const text of ["## Stable IDs", "make update-content-ids", "removed <kind> <id>: <reason>", "A lesson ID is unique in the whole course", "Windows device name"]) {
      expect(COURSES_README, text).toContain(text);
    }
    expect(COURSES_README).not.toContain("checked in #12");
  });

  it("README.md and AGENTS.md name the new targets", () => {
    for (const target of ["build-content", "update-content-ids", "check-content-ids", "check-content-ids-base", "check-images"]) {
      expect(ROOT_README, target).toContain(`\`${target}\``);
      expect(AGENTS, target).toContain(target);
    }
    expect(ROOT_README).toContain("docker compose exec backend ls /app/course-build/private");
    expect(ROOT_README).toContain("`docker-images` job");
    expect(ROOT_README).toContain("npm run build -- ../courses ../build");
    expect(AGENTS).toContain("npm run build -- ../courses ../build");
  });
});
