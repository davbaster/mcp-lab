// What `build` writes for the valid course: the golden folder, the manifest and lesson files, determinism, and what is never public.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CodeStepsJson } from "../src/index.ts";
import { FIXTURES, VALID_COURSE, lessonText, temporaryFolder } from "./helpers.ts";
import { VALID_COURSES, coursesFolder, filesOf, foldersOf, newBuildFolder, runBuild, snapshotOf } from "./build-support.ts";

const GOLDEN = join(FIXTURES, "expected");
/** The folders of the build folder. `expected/lessons/` is the golden folder of another test and is not a build output. */
const ROOTS = ["private", "public", "assets-map"];

async function built(courses = VALID_COURSES, env: Record<string, string | undefined> = {}) {
  const build = newBuildFolder();
  const result = await runBuild([courses, build], { env });
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  return build;
}

const json = (build: string, path: string) => JSON.parse(readFileSync(join(build, ...path.split("/")), "utf8"));

describe("the golden folder", () => {
  it("is exactly what building fixtures/valid writes: every file, byte for byte", async () => {
    const build = await built();
    const golden = new Map<string, Buffer>();
    for (const root of ROOTS) for (const [path, bytes] of filesOf(join(GOLDEN, root), root)) golden.set(path, bytes);
    // The ZIP is not committed: the code JSON says its name, its size, and its SHA-256 (the code tests check the bytes).
    const code = JSON.parse(readFileSync(join(GOLDEN, "private", "code", "sample-course", "01-first-steps.json"), "utf8")) as CodeStepsJson;
    const zipPath = `private/code/sample-course/${code.zip.file}`;

    const actual = filesOf(build);
    const zip = actual.get(zipPath);
    expect([...actual.keys()].sort()).toEqual([...golden.keys(), zipPath].sort());
    expect(zip?.length).toBe(code.zip.size);
    expect(createHash("sha256").update(zip ?? "").digest("hex")).toBe(code.zip.sha256);
    for (const [path, bytes] of golden) expect(actual.get(path)?.equals(bytes), path).toBe(true);
  });

  it("holds the manifest and one file per lesson, which are new, next to the files of the earlier steps", () => {
    expect(readdirSync(join(GOLDEN, "private", "courses"))).toEqual(["sample-course.json"]);
    expect(readdirSync(join(GOLDEN, "private", "lessons", "sample-course"))).toEqual(["01-next.json", "01-welcome.json", "setup.json"]);
  });
});

describe("the manifest", () => {
  it("has the version, the course, and the chapters in course.yaml order, each with its flags and its lessons by order", async () => {
    const manifest = json(await built(), "private/courses/sample-course.json");

    expect(Object.keys(manifest)).toEqual(["schema_version", "course_id", "title", "description", "chapters"]);
    expect(manifest.schema_version).toBe(1);
    expect(manifest.course_id).toBe("sample-course");
    expect(manifest.title).toBe("Sample course");
    expect(manifest.chapters).toEqual([
      {
        id: "01-first-steps",
        free_preview: true,
        has_code: true,
        lessons: [
          { id: "01-welcome", title: "Welcome", order: 1 },
          { id: "setup", title: "Setup", order: 2 },
        ],
      },
      { id: "02-going-further", free_preview: false, has_code: false, lessons: [{ id: "01-next", title: "Next steps", order: 1 }] },
    ]);
    expect(Object.keys(manifest.chapters[0])).toEqual(["id", "free_preview", "has_code", "lessons"]);
  });

  it("has_code is true exactly when private/code/<course>/<chapter>.json exists", async () => {
    const build = await built();
    const manifest = json(build, "private/courses/sample-course.json");

    for (const chapter of manifest.chapters) {
      expect(chapter.has_code, chapter.id).toBe(existsSync(join(build, "private", "code", "sample-course", `${chapter.id}.json`)));
    }
  });

  it("lists lessons by their order, not by their file names or ids", async () => {
    const courses = coursesFolder({
      "sample-course": {
        "chapters/01-first-steps/lessons/01-welcome.mdx": lessonText("Second", 2),
        "chapters/01-first-steps/lessons/02-setup.mdx": lessonText("First", 1, "id: setup\n"),
      },
    });
    const manifest = json(await built(courses), "private/courses/sample-course.json");

    expect(manifest.chapters[0].lessons).toEqual([
      { id: "setup", title: "First", order: 1 },
      { id: "01-welcome", title: "Second", order: 2 },
    ]);
  });

  it("has no title for a chapter yet, and does not list a chapter in progress or write its lessons", async () => {
    const courses = coursesFolder({
      "sample-course": { "chapters/03-later/code/step-1/main.py": "print(1)\n", "chapters/03-later/lessons/01-draft.mdx": null },
    });
    const build = await built(courses);
    const manifest = json(build, "private/courses/sample-course.json");

    expect(manifest.chapters.map((chapter: { id: string }) => chapter.id)).toEqual(["01-first-steps", "02-going-further"]);
    for (const chapter of manifest.chapters) expect(chapter).not.toHaveProperty("title");
    expect(filesOf(build).has("private/code/sample-course/03-later.json")).toBe(false);
  });

  it("copies the title and the description, whatever the line endings", async () => {
    const courses = coursesFolder({
      "sample-course": {
        "course.yaml":
          "id: sample-course\r\ntitle: Ünïcode title\r\ndescription: >-\r\n  First line\r\n  second line.\r\nchapters:\r\n  - 01-first-steps\r\n  - 02-going-further\r\nfree_preview: []\r\n",
      },
    });
    const manifest = json(await built(courses), "private/courses/sample-course.json");

    expect(manifest.title).toBe("Ünïcode title");
    expect(manifest.description).toBe("First line second line.");
    expect(manifest.chapters.every((chapter: { free_preview: boolean }) => chapter.free_preview === false)).toBe(true);
  });
});

describe("the lesson files", () => {
  it("hold the course, the chapter, the lesson, and the tree, in that order, one flat file per lesson", async () => {
    const build = await built();
    const lesson = json(build, "private/lessons/sample-course/setup.json");

    expect(Object.keys(lesson)).toEqual(["course_id", "chapter_id", "lesson_id", "tree"]);
    expect(lesson).toMatchObject({ course_id: "sample-course", chapter_id: "01-first-steps", lesson_id: "setup" });
    expect(lesson.tree.type).toBe("root");
    expect([...filesOf(build, "").keys()].filter((path) => path.startsWith("private/lessons/"))).toEqual([
      "private/lessons/sample-course/01-next.json",
      "private/lessons/sample-course/01-welcome.json",
      "private/lessons/sample-course/setup.json",
    ]);
  });

  it("point every asset at /api/courses/<course_id>/assets/<hashed name>, using the names the build wrote", async () => {
    const build = await built();
    const text = readFileSync(join(build, "private", "lessons", "sample-course", "01-next.json"), "utf8");
    const urls = [...text.matchAll(/"(?:url|src|poster|captions)": "(\/api\/[^"]*)"/g)].map((match) => match[1] ?? "");
    const hashed = new Set(readdirSync(join(build, "public", "assets", "sample-course")));

    expect(urls.length).toBeGreaterThanOrEqual(8);
    for (const url of urls) {
      expect(url).toMatch(/^\/api\/courses\/sample-course\/assets\/[A-Za-z0-9._-]+-[0-9a-f]{16}\.[a-z]+$/);
      expect(hashed.has(url.slice(url.lastIndexOf("/") + 1)), url).toBe(true);
    }
    expect(text).not.toContain('"images/');
  });

  it("keep a media URL and a CodeSteps tag as written", async () => {
    const welcome = `${lessonText("Welcome", 1)}\n<Callout type="tip">\n\n<CodeSteps step="2" file="pkg/util.py" />\n\n</Callout>\n`;
    const build = await built(coursesFolder({ "sample-course": { "chapters/01-first-steps/lessons/01-welcome.mdx": welcome } }));

    expect(readFileSync(join(build, "private", "lessons", "sample-course", "01-next.json"), "utf8")).toContain("https://media.mcp-lab.example/videos/intro.mp4");
    const lesson = json(build, "private/lessons/sample-course/01-welcome.json");
    expect(lesson.tree.children.at(-1).children).toEqual([{ type: "component", name: "CodeSteps", props: { file: "pkg/util.py", step: "2" }, children: [] }]);
  });
});

describe("JSON files", () => {
  it("are UTF-8 without a byte order mark, LF, a 2-space indent, and a final newline", async () => {
    const courses = coursesFolder({ "sample-course": { "chapters/01-first-steps/lessons/01-welcome.mdx": lessonText("Wélcome ✓", 1) } });
    const build = await built(courses);
    const names = [...filesOf(build).keys()].filter((path) => path.endsWith(".json"));

    expect(names.length).toBeGreaterThanOrEqual(8);
    for (const name of names) {
      const bytes = filesOf(build).get(name) as Buffer;
      const text = bytes.toString("utf8");
      expect(bytes[0], name).not.toBe(0xef);
      expect(text, name).not.toContain("\r");
      expect(text.endsWith("\n") && !text.endsWith("\n\n"), name).toBe(true);
      expect(text, name).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
    }
    expect(readFileSync(join(build, "private", "lessons", "sample-course", "01-welcome.json"), "utf8")).toContain("Wélcome ✓");
  });
});

describe("determinism", () => {
  it("building the same courses into two folders gives the same files and the same folders", async () => {
    const courses = coursesFolder({ "sample-course": {}, "second-course": {} });
    const first = await built(courses);
    const second = await built(courses);

    expect(snapshotOf(first)).toEqual(snapshotOf(second));
    expect(filesOf(first).size).toBeGreaterThan(30);
  });

  it("writes the same tree when the course files use CRLF and start with a byte order mark", async () => {
    const lf = await built();
    const crlfCourses = coursesFolder();
    const textFiles = /\.(yaml|mdx|md|py|txt|vtt|svg|gltf|json)$/;
    const convert = (folder: string) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) convert(path);
        else if (textFiles.test(entry.name)) writeFileSync(path, `\uFEFF${readFileSync(path, "utf8").replaceAll("\r\n", "\n").replaceAll("\n", "\r\n")}`);
      }
    };
    convert(crlfCourses);
    expect(readFileSync(join(crlfCourses, "sample-course", "course.yaml"), "utf8")).toMatch(/^\uFEFF.*\r\n/);

    const crlf = await built(crlfCourses);

    expect(snapshotOf(crlf)).toEqual(snapshotOf(lf));
  });

  it("writes no timestamp, no absolute path, and no commit SHA", async () => {
    const courses = coursesFolder();
    const build = await built(courses);
    const forbidden = [courses, build, dirname(courses), process.cwd(), "\\\\"];

    for (const [name, bytes] of filesOf(build)) {
      const text = bytes.toString("latin1");
      for (const path of forbidden) expect(text.includes(path), `${name} has ${path}`).toBe(false);
      expect(text, name).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      if (name.endsWith(".json")) expect(text, name).not.toMatch(/\b[0-9a-f]{40}\b/);
    }
  });
});

describe("what is public", () => {
  it("never holds an answer key, an explanation, a lesson body, or a code step", async () => {
    const SENTINEL = {
      question: "QUESTION-SENTINEL-3c9a41",
      explanation: "EXPLANATION-SENTINEL-77d0be",
      lesson: "LESSON-SENTINEL-5a2f19",
      code: "CODE-SENTINEL-e41b86",
    };
    const quiz = readFileSync(join(VALID_COURSE, "chapters", "01-first-steps", "quiz.yaml"), "utf8")
      .replace("explanation: ", `explanation: ${SENTINEL.explanation} `)
      .replace(/text: (.*)/, `text: ${SENTINEL.question} $1`);
    const courses = coursesFolder({
      "sample-course": {
        "chapters/01-first-steps/quiz.yaml": quiz,
        "chapters/01-first-steps/lessons/01-welcome.mdx": lessonText("Welcome", 1, "").replace("# Welcome", `# Welcome\n\n${SENTINEL.lesson}`),
        "chapters/01-first-steps/code/step-1/main.py": `print("${SENTINEL.code}")\n`,
      },
    });
    const build = await built(courses);

    // The positive control: each sentinel is in the private folder, so a miss in the public one means something.
    const privateText = [...filesOf(join(build, "private"))].map(([, bytes]) => bytes.toString("utf8")).join("\n");
    for (const sentinel of Object.values(SENTINEL)) expect(privateText, sentinel).toContain(sentinel);

    const visible = [...filesOf(join(build, "public")), ...filesOf(join(build, "assets-map"))];
    expect(visible.length).toBeGreaterThan(8);
    for (const [name, bytes] of visible) {
      for (const sentinel of Object.values(SENTINEL)) expect(bytes.toString("latin1").includes(sentinel), `${name} has ${sentinel}`).toBe(false);
    }
    // Public holds only the hashed assets.
    expect([...filesOf(join(build, "public")).keys()].every((path) => path.startsWith("assets/sample-course/"))).toBe(true);
  });
});

describe("the build folder", () => {
  it("has private/ and public/ after every successful build, also when there is no course", async () => {
    const empty = join(temporaryFolder(), "courses");
    mkdirSync(empty);
    writeFileSync(join(empty, "README.md"), "# Courses\n");
    const build = newBuildFolder();

    const result = await runBuild([empty, build]);

    expect(result.code).toBe(0);
    expect(statSync(join(build, "private")).isDirectory()).toBe(true);
    expect(statSync(join(build, "public")).isDirectory()).toBe(true);
    expect(readdirSync(join(build, "private"))).toEqual([]);
    expect(readdirSync(join(build, "public"))).toEqual([]);
    expect(existsSync(join(build, "assets-map"))).toBe(false);
  });

  it("removes the old private/, public/, and assets-map/ and nothing else", async () => {
    const build = newBuildFolder();
    for (const path of ["private/old/secret.json", "public/old.txt", "assets-map/old.json", "keep.txt", "other/x.txt"]) {
      mkdirSync(dirname(join(build, path)), { recursive: true });
      writeFileSync(join(build, path), "old");
    }

    expect((await runBuild([VALID_COURSES, build])).code).toBe(0);

    const files = [...filesOf(build).keys()];
    expect(files).not.toContain("private/old/secret.json");
    expect(files).not.toContain("public/old.txt");
    expect(files).not.toContain("assets-map/old.json");
    expect(files).toContain("keep.txt");
    expect(files).toContain("other/x.txt");
    expect(files).toContain("private/courses/sample-course.json");
  });

  it("does not keep the output of a course that was removed or left out with COURSES", async () => {
    const courses = coursesFolder({ "sample-course": {}, "second-course": {} });
    const build = newBuildFolder();
    expect((await runBuild([courses, build])).code).toBe(0);
    expect(filesOf(build).has("private/courses/second-course.json")).toBe(true);

    expect((await runBuild([courses, build], { env: { COURSES: "sample-course" } })).code).toBe(0);

    const paths = [...filesOf(build).keys()];
    expect(paths.some((path) => path.includes("second-course"))).toBe(false);
    expect(paths).toContain("private/courses/sample-course.json");
    expect(foldersOf(build).some((path) => path.includes("second-course"))).toBe(false);
  });

  it("builds two courses into the same folders without mixing them", async () => {
    const courses = coursesFolder({ "sample-course": {}, "second-course": {} });
    const build = await built(courses);

    expect(readdirSync(join(build, "private", "courses"))).toEqual(["sample-course.json", "second-course.json"]);
    expect(json(build, "private/courses/second-course.json").course_id).toBe("second-course");
    expect(json(build, "private/lessons/second-course/setup.json").course_id).toBe("second-course");
    expect(readFileSync(join(build, "private", "lessons", "second-course", "01-next.json"), "utf8")).toContain("/api/courses/second-course/assets/");
    expect(snapshotOf(join(build, "public", "assets", "second-course")).files).not.toEqual({});
  });
});
