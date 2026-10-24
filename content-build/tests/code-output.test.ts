// writeCodeSteps: the JSON and the ZIP that the backend reads, byte for byte.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { writeCodeSteps, writeQuizzes } from "../src/index.ts";
import type { CodeStepsJson } from "../src/index.ts";
import { CODE, FIXTURES, PART_DIR, SLOW_PROCESS_TIMEOUT_MS, VALID_COURSE, codeCourse, courseYaml, error, makeCourse, temporaryFolder } from "./helpers.ts";

const GOLDEN = join(FIXTURES, "expected", "private", "code", "sample-course");
const GOLDEN_JSON = join(GOLDEN, "01-first-steps.json");
const OUT = ["private", "code", "sample-course"];

/** Every file and folder under `folder` by its path with `/`; a file maps to its bytes, a folder to null. */
function tree(folder: string, prefix = ""): Record<string, Buffer | null> {
  const found: Record<string, Buffer | null> = {};
  for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found[path] = null;
      Object.assign(found, tree(join(folder, entry.name), path));
    } else {
      found[path] = readFileSync(join(folder, entry.name));
    }
  }
  return found;
}

async function built(course = VALID_COURSE) {
  const buildDir = join(temporaryFolder(), "build");
  return { buildDir, problems: await writeCodeSteps(course, buildDir), out: join(buildDir, ...OUT) };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The JSON and the ZIP written for a chapter. */
async function outputOf(course: string, chapter = "01-first-steps") {
  const { out, problems } = await built(course);
  expect(problems).toEqual([]);
  const json = JSON.parse(readFileSync(join(out, `${chapter}.json`), "utf8")) as CodeStepsJson;
  return { out, json, zip: readFileSync(join(out, json.zip.file)), text: readFileSync(join(out, `${chapter}.json`), "utf8") };
}

type ZipEntry = { name: string; method: number; time: number; date: number; attributes: number; madeBy: number; flags: number; extra: number; comment: number };

/** The central directory of a ZIP, read by hand so that the test sees what is stored and not what a library shows. */
function centralDirectory(zip: Buffer): { entries: ZipEntry[]; comment: number } {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const nameLength = zip.readUInt16LE(at + 28);
    entries.push({
      madeBy: zip.readUInt16LE(at + 4),
      flags: zip.readUInt16LE(at + 8),
      method: zip.readUInt16LE(at + 10),
      time: zip.readUInt16LE(at + 12),
      date: zip.readUInt16LE(at + 14),
      extra: zip.readUInt16LE(at + 30),
      comment: zip.readUInt16LE(at + 32),
      attributes: zip.readUInt32LE(at + 38),
      name: zip.toString("utf8", at + 46, at + 46 + nameLength),
    });
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return { entries, comment: zip.readUInt16LE(end + 20) };
}

describe("writeCodeSteps: the files", () => {
  it("writes the golden JSON byte for byte, and its ZIP under the name the JSON gives", async () => {
    const { out, problems } = await built();

    expect(problems).toEqual([]);
    const golden = JSON.parse(readFileSync(GOLDEN_JSON, "utf8")) as CodeStepsJson;
    expect(readFileSync(join(out, "01-first-steps.json")).equals(readFileSync(GOLDEN_JSON))).toBe(true);
    expect(readdirSync(out).sort()).toEqual([golden.zip.file, "01-first-steps.json"].sort());
  });

  it("has the golden JSON as the only file of the golden folder", () => {
    expect(readdirSync(GOLDEN)).toEqual(["01-first-steps.json"]);
  });

  it("covers an added, a modified, a deleted, and an unchanged file, a subfolder, and an empty file in the golden JSON", () => {
    const golden = JSON.parse(readFileSync(GOLDEN_JSON, "utf8")) as CodeStepsJson;
    const files = golden.steps.flatMap((step) => step.files);

    expect(new Set(files.map((file) => file.status))).toEqual(new Set(["added", "modified", "deleted", "unchanged"]));
    expect(files.some((file) => file.path.includes("/"))).toBe(true);
    expect(files.some((file) => file.content === "" && file.status === "added")).toBe(true);
    expect(golden.steps.map((step) => step.step)).toEqual([1, 2, 3]);
  });

  it("writes everything under private/code/<course_id>/ and nothing anywhere else", async () => {
    const { buildDir } = await built();
    const paths = Object.keys(tree(buildDir));

    expect(paths.slice(0, 3)).toEqual(["private", "private/code", "private/code/sample-course"]);
    expect(paths.slice(3).every((path) => path.startsWith("private/code/sample-course/"))).toBe(true);
    expect(paths).toHaveLength(5);
  });

  it("writes no file for a chapter that has no code/ folder", async () => {
    const { out } = await built();

    expect(readdirSync(out).filter((name) => name.startsWith("02-"))).toEqual([]);
  });

  it("writes the JSON with the keys in order, and the ZIP's name, size, and hash", async () => {
    const { json, zip, out } = await outputOf(VALID_COURSE);

    expect(Object.keys(json)).toEqual(["course_id", "chapter_id", "zip", "steps"]);
    expect(Object.keys(json.zip)).toEqual(["file", "sha256", "size"]);
    expect(json.course_id).toBe("sample-course");
    expect(json.chapter_id).toBe("01-first-steps");
    expect(json.zip.sha256).toBe(sha256(zip));
    expect(json.zip.size).toBe(zip.length);
    expect(json.zip.file).toBe(`01-first-steps-${json.zip.sha256.slice(0, 16)}.zip`);
    expect(existsSync(join(out, json.zip.file))).toBe(true);
    expect(json.steps.every((step) => typeof step.step === "number")).toBe(true);
    for (const file of json.steps.flatMap((step) => step.files)) {
      expect(Object.keys(file)).toEqual(["path", "status", "content", "changed_lines"]);
      expect(file.path).not.toContain("\\");
    }
  });

  it("writes UTF-8 without a byte order mark, LF line endings, a 2-space indent, and one final newline", async () => {
    const { text } = await outputOf(VALID_COURSE);
    const bytes = Buffer.from(text);

    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(text).not.toContain("\r");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text.startsWith('{\n  "course_id"')).toBe(true);
    expect(text.split("\n").slice(1, -2).every((line) => /^( {2})+\S/.test(line))).toBe(true);
  });

  it("writes non-ASCII text as it is, not as escapes", async () => {
    const { text } = await outputOf(VALID_COURSE);

    expect(text).toContain("greeting = héllo");
    expect(text).not.toMatch(/\\u[0-9a-fA-F]{4}/);
  });

  it("writes a chapter that has a single step, with every file added", async () => {
    const { json } = await outputOf(codeCourse({ "step-1/main.py": "x = 1\n" }));

    expect(json.steps).toEqual([{ step: 1, files: [{ path: "main.py", status: "added", content: "x = 1\n", changed_lines: [1] }] }]);
  });

  it("writes a step identical to the previous one, with all files unchanged", async () => {
    const { json } = await outputOf(codeCourse({ "step-1/main.py": "x = 1\n", "step-2/main.py": "x = 1\n" }));

    expect(json.steps[1]?.files).toEqual([{ path: "main.py", status: "unchanged", content: "x = 1\n", changed_lines: [] }]);
  });

  it("writes a file for each listed chapter that has steps", async () => {
    const course = makeCourse("sample-course", { "chapters/02-going-further/code/step-1/main.py": "y = 2\n" });
    const { out } = await built(course);

    expect(readdirSync(out).filter((name) => name.endsWith(".json"))).toEqual(["01-first-steps.json", "02-going-further.json"]);
    expect(readdirSync(out).filter((name) => name.endsWith(".zip"))).toHaveLength(2);
  });

  it("writes nothing for an unlisted chapter in progress", async () => {
    const course = makeCourse("sample-course", { "chapters/03-later/code/step-1/main.py": "x = 1\n" });
    const { out, problems } = await built(course);

    expect(problems).toEqual([]);
    expect(readdirSync(out).filter((name) => name.includes("03-later"))).toEqual([]);
    expect(readdirSync(out)).toHaveLength(2);
  });

  it("uses the course folder name as course_id, and keeps two courses apart", async () => {
    const other = makeCourse("other-course", { "course.yaml": courseYaml({ id: "other-course" }) });
    const buildDir = join(temporaryFolder(), "build");

    expect(await writeCodeSteps(VALID_COURSE, buildDir)).toEqual([]);
    expect(await writeCodeSteps(other, buildDir)).toEqual([]);

    expect(readdirSync(join(buildDir, "private", "code")).sort()).toEqual(["other-course", "sample-course"]);
    const json = JSON.parse(readFileSync(join(buildDir, "private", "code", "other-course", "01-first-steps.json"), "utf8"));
    expect(json.course_id).toBe("other-course");
  });
});

describe("writeCodeSteps: the same bytes everywhere", () => {
  it("gives the same files for the same course in two course folders and two build folders", async () => {
    const first = await built();
    const second = await built(makeCourse("sample-course"));

    expect(tree(second.buildDir)).toEqual(tree(first.buildDir));
  });

  it("gives the same ZIP, with the hash that the golden JSON holds", async () => {
    const golden = JSON.parse(readFileSync(GOLDEN_JSON, "utf8")) as CodeStepsJson;
    const { zip } = await outputOf(VALID_COURSE);

    expect(sha256(zip)).toBe(golden.zip.sha256);
  });

  it("gives the same JSON and the same ZIP for a step written with CRLF and a byte order mark", async () => {
    const plain = codeCourse({ "step-1/main.py": "a = 1\nb = 2\n", "step-2/main.py": "a = 1\nb = 3\nc = 4", "step-2/e.txt": "" });
    const windows = codeCourse({
      "step-1/main.py": "﻿a = 1\r\nb = 2\r\n",
      "step-2/main.py": "﻿a = 1\r\nb = 3\r\nc = 4",
      "step-2/e.txt": "﻿",
    });

    expect(readFileSync(join(windows, ...CODE.split("/"), "step-1", "main.py"), "utf8")).toContain("\r\n");
    const a = await built(plain);
    const b = await built(windows);
    expect(b.problems).toEqual([]);
    expect(tree(b.buildDir)).toEqual(tree(a.buildDir));
  });

  it("gives a new ZIP name when the final step changes, and the same name when only an earlier step changes", async () => {
    const files = (first: string, last: string) => ({ "step-1/main.py": first, "step-2/main.py": last });
    const name = async (course: string) => (await outputOf(course)).json.zip.file;
    const base = await name(codeCourse(files("a\n", "b\n")));

    expect(await name(codeCourse(files("a\n", "c\n")))).not.toBe(base);
    expect(await name(codeCourse(files("changed\n", "b\n")))).toBe(base);
  });

  // The runs below are in separate processes, because the time zone and the working folder are set per process.
  const script = `import { writeCodeSteps } from ${JSON.stringify(pathToFileURL(join(PART_DIR, "src", "index.ts")).href)};
    process.exitCode = (await writeCodeSteps("sample-course", "out-" + process.argv[1])).length;`;
  function inProcess(course: string, name: string, env: Record<string, string>) {
    const cwd = dirname(course);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, name], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
    expect(result.status, result.stderr).toBe(0);
    return tree(join(cwd, `out-${name}`));
  }

  it.each([
    ["Pacific/Kiritimati", "America/Los_Angeles"],
    ["UTC", "Asia/Kolkata"],
  ])("gives the same bytes when TZ is %s and %s, and from different working folders", (zoneA, zoneB) => {
    const first = inProcess(makeCourse("sample-course"), "one", { TZ: zoneA });
    const second = inProcess(makeCourse("sample-course"), "two", { TZ: zoneB });

    expect(Object.keys(first)).toHaveLength(5);
    expect(second).toEqual(first);
    const golden = JSON.parse(readFileSync(GOLDEN_JSON, "utf8")) as CodeStepsJson;
    const zip = first[`private/code/sample-course/${golden.zip.file}`];
    expect(zip).toBeInstanceOf(Buffer);
    expect(sha256(zip!)).toBe(golden.zip.sha256);
  }, SLOW_PROCESS_TIMEOUT_MS);
});

describe("the ZIP", () => {
  const files = { "step-1/main.py": "print(1)\n", "step-2/main.py": "print(2)\n", "step-2/src/util.py": "def f():\n    return 1\n", "step-2/e.txt": "", "step-2/Z.md": "# Z\n" };
  const zipOf = async (course = codeCourse(files)) => (await outputOf(course)).zip;

  it("has exactly the files of the final step under the chapter folder, in the order of the JSON, with no folder entries", async () => {
    const zip = await zipOf();
    const { entries } = centralDirectory(zip);

    expect(entries.map((entry) => entry.name)).toEqual(["01-first-steps/Z.md", "01-first-steps/e.txt", "01-first-steps/main.py", "01-first-steps/src/util.py"]);
    expect(entries.every((entry) => !entry.name.endsWith("/") && !entry.name.includes("\\"))).toBe(true);
  });

  it("holds the text of the final step: unzipped names and text equal the step", async () => {
    const unzipped = await JSZip.loadAsync(await zipOf());
    const text: Record<string, string> = {};
    for (const [name, entry] of Object.entries(unzipped.files)) text[name] = await entry.async("string");

    expect(text).toEqual({
      "01-first-steps/Z.md": "# Z\n",
      "01-first-steps/e.txt": "",
      "01-first-steps/main.py": "print(2)\n",
      "01-first-steps/src/util.py": "def f():\n    return 1\n",
    });
  });

  it("does not hold a file that the final step deleted", async () => {
    const zip = await zipOf(codeCourse({ "step-1/old.py": "x", "step-1/keep.py": "x", "step-2/keep.py": "y" }));

    expect(centralDirectory(zip).entries.map((entry) => entry.name)).toEqual(["01-first-steps/keep.py"]);
  });

  it("holds the normalized text, so the download is the same as what the viewer copies", async () => {
    const zip = await zipOf(codeCourse({ "step-1/main.py": "﻿a\r\nb\rc\r\n" }));
    const unzipped = await JSZip.loadAsync(zip);

    expect(await unzipped.file("01-first-steps/main.py")?.async("string")).toBe("a\nb\rc\n");
  });

  it("stores the time 1980-01-01 00:00:00, the mode 0644, and no comment, on every entry", async () => {
    const { entries, comment } = centralDirectory(await zipOf());

    expect(comment).toBe(0);
    for (const entry of entries) {
      expect(entry.time).toBe(0);
      expect(entry.date).toBe((0 << 9) | (1 << 5) | 1);
      expect(entry.attributes >>> 16).toBe(0o100644);
      expect(entry.madeBy >> 8).toBe(3);
      expect(entry.comment).toBe(0);
    }
  });

  it("uses one compression setting: deflate for every file that has content", async () => {
    const { entries } = centralDirectory(await zipOf());

    expect(entries.filter((entry) => entry.name !== "01-first-steps/e.txt").map((entry) => entry.method)).toEqual([8, 8, 8]);
  });

  it("keeps a non-ASCII file name as UTF-8", async () => {
    const zip = await zipOf(codeCourse({ "step-1/données/日本.txt": "x" }));

    expect(centralDirectory(zip).entries.map((entry) => entry.name)).toEqual(["01-first-steps/données/日本.txt"]);
  });
});

describe("writeCodeSteps: the build folder", () => {
  it("removes the old files of the course, and only the course's folder", async () => {
    const buildDir = join(temporaryFolder(), "build");
    const stale = join(buildDir, ...OUT);
    mkdirSync(stale, { recursive: true });
    mkdirSync(join(stale, "nested"));
    mkdirSync(join(buildDir, "private", "code", "other-course"), { recursive: true });
    writeFileSync(join(stale, "03-removed-chapter.json"), "{}\n");
    writeFileSync(join(stale, "03-removed-chapter-0123456789abcdef.zip"), "x");
    writeFileSync(join(stale, "nested", "x.json"), "{}\n");
    writeFileSync(join(buildDir, "private", "code", "other-course", "01-a.json"), "{}\n");
    writeFileSync(join(buildDir, "private", "keep.txt"), "keep\n");
    writeFileSync(join(buildDir, "unrelated.txt"), "keep\n");

    expect(await writeCodeSteps(VALID_COURSE, buildDir)).toEqual([]);

    const now = tree(buildDir);
    expect(Object.keys(now).filter((path) => path.startsWith("private/code/sample-course/"))).toHaveLength(2);
    expect(now["private/code/other-course/01-a.json"]?.toString()).toBe("{}\n");
    expect(now["private/keep.txt"]?.toString()).toBe("keep\n");
    expect(now["unrelated.txt"]?.toString()).toBe("keep\n");
  });

  it("leaves the quizzes under private/ untouched", async () => {
    const buildDir = join(temporaryFolder(), "build");
    expect(writeQuizzes(VALID_COURSE, buildDir)).toEqual([]);
    const quizzes = Object.fromEntries(Object.entries(tree(buildDir)));

    expect(await writeCodeSteps(VALID_COURSE, buildDir)).toEqual([]);

    const now = tree(buildDir);
    for (const [path, content] of Object.entries(quizzes)) expect(now[path]).toEqual(content);
    expect(Object.keys(now).filter((path) => path.startsWith("private/code/sample-course/"))).toHaveLength(2);
  });

  it("leaves no old file for a chapter that lost its code, and creates nothing when no chapter has code", async () => {
    const buildDir = join(temporaryFolder(), "build");
    expect(await writeCodeSteps(VALID_COURSE, buildDir)).toEqual([]);
    const withoutCode = makeCourse("sample-course", { [CODE]: null });

    expect(await writeCodeSteps(withoutCode, buildDir)).toEqual([]);

    expect(existsSync(join(buildDir, ...OUT))).toBe(false);
    expect(existsSync(join(buildDir, "private"))).toBe(true);
  });

  it("creates nothing at all when no chapter has code and the build folder is new", async () => {
    const buildDir = join(temporaryFolder(), "build");

    expect(await writeCodeSteps(makeCourse("sample-course", { [CODE]: null }), buildDir)).toEqual([]);

    expect(existsSync(buildDir)).toBe(false);
  });

  it("removes only the stale files of a chapter that lost its code, when another chapter still has code", async () => {
    const buildDir = join(temporaryFolder(), "build");
    const both = makeCourse("sample-course", { "chapters/02-going-further/code/step-1/main.py": "y = 2\n" });
    expect(await writeCodeSteps(both, buildDir)).toEqual([]);
    expect(readdirSync(join(buildDir, ...OUT))).toHaveLength(4);

    expect(await writeCodeSteps(VALID_COURSE, buildDir)).toEqual([]);

    expect(readdirSync(join(buildDir, ...OUT)).filter((name) => name.startsWith("02-"))).toEqual([]);
  });

  it("writes nothing, and creates nothing, when a step has an error", async () => {
    const course = codeCourse({ "step-1/main.py": "x", "step-3/main.py": "x" });
    const buildDir = join(temporaryFolder(), "build");

    expect(await writeCodeSteps(course, buildDir)).toEqual([
      error(CODE, "`step-2` is missing; steps must be numbered 1, 2, 3, and so on with no gaps"),
    ]);
    expect(existsSync(buildDir)).toBe(false);
  });

  it("leaves an existing build folder as it was when a step has an error", async () => {
    const buildDir = join(temporaryFolder(), "build");
    expect(await writeCodeSteps(VALID_COURSE, buildDir)).toEqual([]);
    const before = tree(buildDir);

    const problems = await writeCodeSteps(codeCourse({ "step-1/main.py": Uint8Array.of(0xff) }), buildDir);

    expect(problems).toHaveLength(1);
    expect(tree(buildDir)).toEqual(before);
  });

  it("writes none of the files when only one of two chapters has an error", async () => {
    const course = makeCourse("sample-course", { "chapters/02-going-further/code/step-2/main.py": "x" });
    const buildDir = join(temporaryFolder(), "build");

    expect(await writeCodeSteps(course, buildDir)).toEqual([
      error("chapters/02-going-further/code", "`step-1` is missing; steps must be numbered 1, 2, 3, and so on with no gaps"),
    ]);
    expect(existsSync(buildDir)).toBe(false);
  });

  it("returns the problems of every chapter's steps, sorted, and no others", async () => {
    const course = makeCourse("sample-course", {
      "chapters/02-going-further/code/step-2/main.py": "x",
      [CODE]: null,
      [`${CODE}/step-1/main.py`]: Uint8Array.of(0xff),
      "course.yaml": courseYaml({ description: "" }),
    });

    const problems = await writeCodeSteps(course, join(temporaryFolder(), "build"));

    expect(problems.map((problem) => [problem.severity, problem.file])).toEqual([
      ["error", "chapters/01-first-steps/code/step-1/main.py"],
      ["error", "chapters/02-going-further/code"],
    ]);
  });

  it("does not check the rest of the course", async () => {
    // validateCourse reports that problem; the caller runs it first.
    const course = makeCourse("sample-course", { "course.yaml": courseYaml({ description: "" }) });
    const { problems, out } = await built(course);

    expect(problems).toEqual([]);
    expect(readdirSync(out)).toHaveLength(2);
  });

  it("returns the problems of the course, and writes nothing, when a listed chapter cannot be checked", async () => {
    const course = makeCourse("sample-course", { "chapters/02-going-further": null });
    const buildDir = join(temporaryFolder(), "build");

    const problems = await writeCodeSteps(course, buildDir);

    expect(problems.map((problem) => problem.message)).toEqual([
      "chapter `02-going-further` is listed in `chapters` but chapters/02-going-further does not exist",
    ]);
    expect(existsSync(buildDir)).toBe(false);
  });

  it("returns the problem when there is no course folder, and writes nothing", async () => {
    const buildDir = join(temporaryFolder(), "build");

    expect(await writeCodeSteps(join(FIXTURES, "nowhere"), buildDir)).toEqual([error("", "the course folder does not exist")]);
    expect(existsSync(buildDir)).toBe(false);
  });

  it("refuses a course folder name that is not a valid course ID", async () => {
    const course = makeCourse("Sample Course", { "course.yaml": courseYaml({ id: "Sample Course" }) });
    const buildDir = join(temporaryFolder(), "build");

    expect(await writeCodeSteps(course, buildDir)).toHaveLength(1);
    expect(existsSync(buildDir)).toBe(false);
  });

  it("needs a build folder", async () => {
    await expect(writeCodeSteps(VALID_COURSE, " ")).rejects.toThrow("build folder");
  });
});

describe("the output is private", () => {
  it("never writes outside private/, so a frontend image that excludes private/ holds no code step", async () => {
    const { buildDir } = await built();

    expect(Object.keys(tree(buildDir)).every((path) => path === "private" || path.startsWith("private/"))).toBe(true);
  });
});
