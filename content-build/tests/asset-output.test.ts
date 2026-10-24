// writeAssets: the hashed public files, the map, and the promise that nothing under private/ is touched or served.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectCourse } from "../src/course.ts";
import { writeAssets, writeCodeSteps, writeQuizzes } from "../src/index.ts";
import { GLB, GLTF, JPG, NEXT, PNG, SVG, VTT, WEBP, assetCourse, fixtureAsset } from "./asset-helpers.ts";
import { FIXTURES, VALID_COURSE, makeCourse, temporaryFolder } from "./helpers.ts";

const GOLDEN = join(FIXTURES, "expected");

/** Every file under `folder` by its path with `/`, mapped to its bytes. A missing folder is empty. */
function files(folder: string, prefix = ""): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  if (!existsSync(folder)) return found;
  for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) for (const [name, bytes] of files(join(folder, entry.name), path)) found.set(name, bytes);
    else found.set(path, readFileSync(join(folder, entry.name)));
  }
  return found;
}

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const buildFolder = () => join(temporaryFolder(), "build");
const mapOf = (build: string, id = "sample-course") => JSON.parse(readFileSync(join(build, "assets-map", `${id}.json`), "utf8"));
const publicOf = (build: string, id = "sample-course") => files(join(build, "public", "assets", id));
/** The same files, as a comparable record of path to hex of the bytes. */
const snapshot = (folder: string) => Object.fromEntries([...files(folder)].map(([path, bytes]) => [path, bytes.toString("hex")]));

describe("the valid course", () => {
  it("writes exactly the committed golden files: the hashed assets and the map", () => {
    const build = buildFolder();

    expect(writeAssets(VALID_COURSE, build)).toEqual([]);

    const golden = files(join(GOLDEN, "public", "assets", "sample-course"));
    expect([...publicOf(build).keys()]).toEqual([...golden.keys()]);
    for (const [name, bytes] of golden) expect(publicOf(build).get(name)?.equals(bytes), name).toBe(true);
    expect(readFileSync(join(build, "assets-map", "sample-course.json")).equals(readFileSync(join(GOLDEN, "assets-map", "sample-course.json")))).toBe(true);
    expect([...files(build).keys()].filter((path) => !path.startsWith("public/assets/sample-course/"))).toEqual(["assets-map/sample-course.json"]);
  });

  it("names each file <stem>-<first 16 hex digits of the SHA-256 of the bytes written>.<ext>, flat", () => {
    const build = buildFolder();
    writeAssets(VALID_COURSE, build);

    for (const [name, bytes] of publicOf(build)) {
      expect(name).toBe(name.replace(/\/.*/, ""));
      expect(name).toMatch(/^[A-Za-z0-9._-]+-[0-9a-f]{16}\.[a-z]+$/);
      expect(name.slice(name.lastIndexOf("-") + 1, name.lastIndexOf("."))).toBe(sha(bytes).slice(0, 16));
    }
    expect([...publicOf(build).keys()]).toContain(`pic-${sha(PNG).slice(0, 16)}.png`);
  });

  it("describes each file in the map: the hashed name, the full SHA-256, and the size in bytes", () => {
    const build = buildFolder();
    writeAssets(VALID_COURSE, build);
    const map = mapOf(build);

    expect(map.course_id).toBe("sample-course");
    expect(Object.keys(map)).toEqual(["course_id", "files"]);
    expect(Object.keys(map.files)).toEqual([
      "captions/intro.vtt",
      "diagrams/flow.svg",
      "images/banner.webp",
      "images/logo.svg",
      "images/photo.jpg",
      "images/pic.png",
      "models/box.gltf",
      "models/server.glb",
    ]);
    for (const [path, entry] of Object.entries(map.files) as [string, { file: string; sha256: string; size: number }][]) {
      const written = publicOf(build).get(entry.file);
      expect(Object.keys(entry), path).toEqual(["file", "sha256", "size"]);
      expect(entry.sha256, path).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.sha256, path).toBe(sha(written ?? ""));
      expect(entry.size, path).toBe(written?.length);
      expect(entry.file, path).toBe(`${path.slice(path.lastIndexOf("/") + 1, path.lastIndexOf("."))}-${entry.sha256.slice(0, 16)}.${path.slice(path.lastIndexOf(".") + 1)}`);
    }
    // The binary files are used byte for byte.
    expect(publicOf(build).get(map.files["images/pic.png"].file)?.equals(PNG)).toBe(true);
    expect(publicOf(build).get(map.files["images/photo.jpg"].file)?.equals(JPG)).toBe(true);
    expect(publicOf(build).get(map.files["images/banner.webp"].file)?.equals(WEBP)).toBe(true);
    expect(publicOf(build).get(map.files["models/server.glb"].file)?.equals(GLB)).toBe(true);
  });

  it("writes the map as UTF-8 without a byte order mark, with LF, a 2-space indent, and a final newline", () => {
    const build = buildFolder();
    writeAssets(VALID_COURSE, build);
    const bytes = readFileSync(join(build, "assets-map", "sample-course.json"));
    const text = bytes.toString("utf8");

    expect(bytes[0]).not.toBe(0xef);
    expect(text.includes("\r")).toBe(false);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
    expect(text.split("\n")[1]).toBe('  "course_id": "sample-course",');
  });

  it("puts the map outside public/, so it is never served", () => {
    const build = buildFolder();
    writeAssets(VALID_COURSE, build);

    expect([...files(join(build, "public")).keys()].some((path) => path.endsWith(".json"))).toBe(false);
    expect(existsSync(join(build, "public", "assets-map"))).toBe(false);
  });
});

describe("keys, names, and duplicates", () => {
  it("sorts the keys of the map in code-unit order, not by locale or case", () => {
    const course = assetCourse({ "b.png": PNG, "A.png": PNG, "a2.png": PNG, "_a.png": PNG, "Z/y.png": PNG, "m/x.png": PNG, "10.png": PNG, "2.png": PNG });
    const build = buildFolder();

    expect(writeAssets(course, build)).toEqual([]);

    expect(Object.keys(mapOf(build).files)).toEqual(["10.png", "2.png", "A.png", "Z/y.png", "_a.png", "a2.png", "b.png", "m/x.png"]);
  });

  it("writes two paths with identical bytes and the same stem as one file", () => {
    const course = assetCourse({ "a/pic.png": PNG, "b/pic.png": PNG, "c/other.png": PNG });
    const build = buildFolder();
    writeAssets(course, build);
    const map = mapOf(build);

    expect(map.files["a/pic.png"].file).toBe(map.files["b/pic.png"].file);
    expect(map.files["c/other.png"].file).not.toBe(map.files["a/pic.png"].file);
    expect(publicOf(build).size).toBe(2);
  });

  it("writes two files with the same stem and different bytes under different names", () => {
    const course = assetCourse({ "a/pic.png": PNG, "b/pic.png": Buffer.concat([PNG, Buffer.from("x")]) });
    const build = buildFolder();
    writeAssets(course, build);
    const map = mapOf(build);

    expect(map.files["a/pic.png"].file).not.toBe(map.files["b/pic.png"].file);
    expect([...publicOf(build).keys()]).toHaveLength(2);
  });

  it("gives a file that changes a new name, and a file that moves between folders the same name", () => {
    const name = (assets: Record<string, string | Uint8Array>) => {
      const build = buildFolder();
      writeAssets(assetCourse(assets), build);
      return Object.values(mapOf(build).files as Record<string, { file: string }>).map((entry) => entry.file);
    };
    const before = name({ "images/pic.png": PNG });

    expect(name({ "images/pic.png": Buffer.concat([PNG, Buffer.from([0])]) })).not.toEqual(before);
    expect(name({ "other/folder/pic.png": PNG })).toEqual(before);
    expect(name({ "pic.png": PNG })).toEqual(before);
  });

  it("writes an extension in capital letters as lowercase, keeping the stem as it is", () => {
    const build = buildFolder();
    writeAssets(assetCourse({ "images/Pic.PNG": PNG, "images/Model.GLB": GLB, "c.Vtt": VTT }), build);

    expect(Object.values(mapOf(build).files as Record<string, { file: string }>).map((entry) => entry.file.replace(/-[0-9a-f]{16}/, "-H"))).toEqual(["c-H.vtt", "Model-H.glb", "Pic-H.png"]);
    expect([...publicOf(build).keys()].every((name) => name === name.replace(/\.[A-Za-z]+$/, (e) => e.toLowerCase()))).toBe(true);
  });

  it("writes a file in a folder named private/ flat, under public/assets/<course_id>/, and nowhere else", () => {
    const course = assetCourse({ "private/secret.png": PNG, "images/private/deep.png": PNG });
    const build = buildFolder();

    expect(writeAssets(course, build)).toEqual([]);

    const all = [...files(build).keys()];
    expect(all.filter((path) => path.startsWith("public/"))).toEqual([
      `public/assets/sample-course/deep-${sha(PNG).slice(0, 16)}.png`,
      `public/assets/sample-course/secret-${sha(PNG).slice(0, 16)}.png`,
    ]);
    expect(all.filter((path) => path.split("/").includes("private"))).toEqual([]);
    expect(Object.keys(mapOf(build).files)).toEqual(["images/private/deep.png", "private/secret.png"]);
    expect(existsSync(join(build, "private"))).toBe(false);
  });
});

describe("text files are normalized before they are hashed", () => {
  const texts = { "diagrams/flow.svg": SVG, "captions/intro.vtt": VTT, "models/box.gltf": GLTF };

  it("gives the same output for CRLF, lone CR, and a byte order mark as for LF", () => {
    const build = (change: (text: string) => string) => {
      const folder = buildFolder();
      const course = assetCourse(Object.fromEntries(Object.entries(texts).map(([path, text]) => [path, change(text)])));
      expect(writeAssets(course, folder)).toEqual([]);
      return folder;
    };
    const lf = build((text) => text);

    for (const change of [(t: string) => t.replaceAll("\n", "\r\n"), (t: string) => t.replaceAll("\n", "\r"), (t: string) => `\uFEFF${t}`, (t: string) => `\uFEFF${t.replaceAll("\n", "\r\n")}`]) {
      const other = build(change);
      expect(snapshot(join(other, "public")), String(change)).toEqual(snapshot(join(lf, "public")));
      expect(readFileSync(join(other, "assets-map", "sample-course.json"), "utf8")).toBe(readFileSync(join(lf, "assets-map", "sample-course.json"), "utf8"));
    }
  });

  it("removes one leading byte order mark and changes only line endings, and the size is the size written", () => {
    const build = buildFolder();
    writeAssets(assetCourse({ "c.vtt": `\uFEFFWEBVTT\r\n\r\n00:00.000 --> 00:01.000\r\nHi\rthere\r\n` }), build);
    const entry = mapOf(build).files["c.vtt"];

    expect(publicOf(build).get(entry.file)?.toString("utf8")).toBe("WEBVTT\n\n00:00.000 --> 00:01.000\nHi\nthere\n");
    expect(entry.size).toBe(Buffer.byteLength("WEBVTT\n\n00:00.000 --> 00:01.000\nHi\nthere\n"));
    expect(entry.sha256).toBe(sha("WEBVTT\n\n00:00.000 --> 00:01.000\nHi\nthere\n"));
  });

  it("does not change binary files: bytes that look like CRLF or a BOM stay", () => {
    const tricky = Buffer.concat([PNG, Buffer.from("\r\n\r\xef\xbb\xbf")]);
    const build = buildFolder();
    writeAssets(assetCourse({ "a.png": tricky }), build);

    expect(publicOf(build).get(mapOf(build).files["a.png"].file)?.equals(tricky)).toBe(true);
  });
});

describe("determinism", () => {
  it("builds the same input twice to byte-identical output, into two folders and into the same folder", () => {
    const first = buildFolder();
    const second = buildFolder();

    writeAssets(VALID_COURSE, first);
    writeAssets(VALID_COURSE, second);
    const before = snapshot(first);
    writeAssets(VALID_COURSE, first);

    expect(snapshot(second)).toEqual(before);
    expect(snapshot(first)).toEqual(before);
    expect(Object.keys(before).length).toBe(9);
  });

  it("does not depend on where the course folder is, where the build folder is, or on the working folder", () => {
    const copy = join(temporaryFolder(), "deeper", "still", "sample-course");
    mkdirSync(dirname(copy), { recursive: true });
    cpSync(VALID_COURSE, copy, { recursive: true });
    const a = buildFolder();
    const b = join(temporaryFolder(), "x", "y", "build");

    writeAssets(VALID_COURSE, a);
    writeAssets(copy, b);

    expect(snapshot(b)).toEqual(snapshot(a));
  });

  it("gives the same output in a child process started in another working folder", () => {
    const build = buildFolder();
    const expected = buildFolder();
    writeAssets(VALID_COURSE, expected);
    const script = `import("${join(dirname(FIXTURES), "src", "index.ts").replaceAll("\\", "/")}").then((m) => { const p = m.writeAssets(process.argv[1], process.argv[2]); if (p.length) process.exit(1); });`;

    const result = spawnSync(process.execPath, ["-e", script, VALID_COURSE, build], { cwd: temporaryFolder(), encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(snapshot(build)).toEqual(snapshot(expected));
  });
});

describe("what writeAssets removes and leaves", () => {
  it("removes only public/assets/<course_id>/ and the map of that course, including files of an earlier build", () => {
    const build = buildFolder();
    writeAssets(assetCourse({ "old.png": PNG, "models/old.glb": GLB }), build);
    const oldNames = [...publicOf(build).keys()];
    writeFileSync(join(build, "public", "assets", "sample-course", "stray.txt"), "left by hand");
    mkdirSync(join(build, "public", "assets", "sample-course", "sub"));
    writeFileSync(join(build, "public", "assets", "sample-course", "sub", "deep.txt"), "x");
    writeFileSync(join(build, "elsewhere.txt"), "stays");

    writeAssets(assetCourse({ "new.png": PNG }), build);

    expect(oldNames).toHaveLength(2);
    expect([...publicOf(build).keys()]).toEqual([`new-${sha(PNG).slice(0, 16)}.png`]);
    expect(readFileSync(join(build, "elsewhere.txt"), "utf8")).toBe("stays");
  });

  it("with no files in assets/ writes no asset files, and a map with an empty files object, and removes the earlier files", () => {
    const build = buildFolder();
    writeAssets(VALID_COURSE, build);

    for (const course of [assetCourse({}, undefined, { assets: null }), assetCourse({ ".DS_Store": "x" }), assetCourse({ "empty/.DS_Store": "x" })]) {
      expect(writeAssets(course, build)).toEqual([]);
      expect([...files(build).keys()]).toEqual(["assets-map/sample-course.json"]);
      expect(readFileSync(join(build, "assets-map", "sample-course.json"), "utf8")).toBe('{\n  "course_id": "sample-course",\n  "files": {}\n}\n');
      expect(existsSync(join(build, "public", "assets", "sample-course"))).toBe(false);
      writeAssets(VALID_COURSE, build);
    }
  });

  it("does not copy a .DS_Store or Thumbs.db", () => {
    const build = buildFolder();
    writeAssets(assetCourse({ "images/pic.png": PNG, ".DS_Store": "x", "images/Thumbs.db": "x", "images/.DS_Store": "x" }), build);

    expect(Object.keys(mapOf(build).files)).toEqual(["images/pic.png"]);
    expect(publicOf(build).size).toBe(1);
  });

  it("builds two courses into one build folder without touching each other", () => {
    const build = buildFolder();
    const a = assetCourse({ "a.png": PNG });
    const second = join(temporaryFolder(), "other-course");
    cpSync(makeCourse("sample-course", { assets: null, [NEXT]: null, "chapters/02-going-further": null, "course.yaml": null, "assets/b.png": PNG }), second, { recursive: true });
    writeFileSync(join(second, "course.yaml"), "id: other-course\ntitle: Other\ndescription: Another course.\nchapters:\n  - 01-first-steps\nfree_preview: []\n");

    writeAssets(a, build);
    const afterA = snapshot(build);
    expect(writeAssets(second, build)).toEqual([]);

    expect(Object.keys(mapOf(build, "other-course").files)).toEqual(["b.png"]);
    expect(publicOf(build, "sample-course").size).toBe(1);
    expect(publicOf(build, "other-course").size).toBe(1);
    const afterB = snapshot(build);
    for (const [path, bytes] of Object.entries(afterA)) expect(afterB[path], path).toBe(bytes);

    // Rebuilding the first course leaves the second one as it was.
    writeAssets(assetCourse({ "c.png": PNG }), build);
    expect(Object.keys(mapOf(build, "other-course").files)).toEqual(["b.png"]);
    expect(publicOf(build, "other-course").size).toBe(1);
  });
});

describe("a course with a problem", () => {
  const seed = (build: string) => {
    mkdirSync(join(build, "public", "assets", "sample-course"), { recursive: true });
    mkdirSync(join(build, "assets-map"), { recursive: true });
    mkdirSync(join(build, "private", "quizzes"), { recursive: true });
    writeFileSync(join(build, "public", "assets", "sample-course", "keep-0123456789abcdef.png"), "kept");
    writeFileSync(join(build, "assets-map", "sample-course.json"), "kept map");
    writeFileSync(join(build, "private", "quizzes", "q.json"), "kept quiz");
  };

  it("writes nothing, leaves the build folder as it was, and returns the problems", () => {
    const build = buildFolder();
    seed(build);
    const before = snapshot(build);
    const course = assetCourse({ "good.png": PNG, "bad.png": "not a png", "notes.txt": "x" });

    const problems = writeAssets(course, build);

    expect(problems.map((p) => [p.severity, p.file])).toEqual([
      ["error", "assets/bad.png"],
      ["error", "assets/notes.txt"],
    ]);
    expect(snapshot(build)).toEqual(before);
  });

  it("writes nothing for a build folder that does not exist yet", () => {
    const build = buildFolder();

    expect(writeAssets(assetCourse({ "notes.txt": "x" }), build)).toHaveLength(1);
    expect(existsSync(build)).toBe(false);
  });

  it("returns the problems of an unreadable course folder", () => {
    expect(writeAssets(join(temporaryFolder(), "missing"), buildFolder())).toEqual([{ severity: "error", file: "", message: "the course folder does not exist" }]);
  });

  it("returns an error for a course folder name that is not lowercase letters, digits, and hyphens", () => {
    const course = join(temporaryFolder(), "Bad_Name");
    cpSync(VALID_COURSE, course, { recursive: true });
    const build = buildFolder();

    expect(writeAssets(course, build)).toEqual([
      { severity: "error", file: "", message: "the course folder name must use only lowercase letters, digits, and hyphens" },
    ]);
    expect(existsSync(build)).toBe(false);
  });

  it("throws for an empty build folder", () => {
    expect(() => writeAssets(VALID_COURSE, "")).toThrow("writeAssets needs the build folder");
    expect(() => writeAssets(VALID_COURSE, "   ")).toThrow("writeAssets needs the build folder");
  });

  it("does not check the lessons: a lesson with a problem does not stop the assets", () => {
    const course = assetCourse({ "a.png": PNG }, "{1 + 1}\n");
    const build = buildFolder();

    expect(writeAssets(course, build)).toEqual([]);
    expect(publicOf(build).size).toBe(1);
  });

  it("does not write when a file is empty", () => {
    const build = buildFolder();

    expect(writeAssets(assetCourse({ "empty.png": "" }), build)).toHaveLength(1);
    expect(existsSync(join(build, "public"))).toBe(false);
  });
});

describe("the public output never includes private/", () => {
  const CORRECT = "CORRECT-OPTION-SENTINEL-7f3a";
  const EXPLANATION = "EXPLANATION-SENTINEL-7f3a";

  async function everything() {
    const quizPath = "chapters/01-first-steps/quiz.yaml";
    const quiz = readFileSync(join(VALID_COURSE, quizPath), "utf8")
      .replace("text: A small sample", `text: ${CORRECT}`)
      .replace("explanation: The sample course exists to show the format.", `explanation: ${EXPLANATION}`);
    const course = makeCourse("sample-course", { [quizPath]: quiz });
    const build = buildFolder();
    expect(writeQuizzes(course, build)).toEqual([]);
    expect(await writeCodeSteps(course, build)).toEqual([]);
    return { course, build };
  }

  it("keeps public/ to exactly the hashed asset files, and the private/ tree byte-identical", async () => {
    const { course, build } = await everything();
    const privateBefore = snapshot(join(build, "private"));

    expect(writeAssets(course, build)).toEqual([]);

    const publicFiles = files(join(build, "public"));
    const golden = files(join(GOLDEN, "public"));
    expect([...publicFiles.keys()]).toEqual([...golden.keys()]);
    expect([...publicFiles.keys()].every((path) => path.startsWith("assets/sample-course/"))).toBe(true);
    for (const path of publicFiles.keys()) expect(path.split("/")).not.toContain("private");
    expect(Object.keys(privateBefore).length).toBeGreaterThan(3);
    expect(snapshot(join(build, "private"))).toEqual(privateBefore);
    // No file under public/ is a file of private/, by name or by content.
    const privateContents = new Set([...files(join(build, "private")).values()].map((bytes) => sha(bytes)));
    for (const [path, bytes] of publicFiles) expect(privateContents.has(sha(bytes)), path).toBe(false);
  });

  it("puts the quiz answer and explanation sentinels in private/ and in no file under public/ or assets-map/", async () => {
    const { course, build } = await everything();
    writeAssets(course, build);

    const privateText = [...files(join(build, "private")).values()].map((bytes) => bytes.toString("utf8")).join("\n");
    expect(privateText).toContain(CORRECT);
    expect(privateText).toContain(EXPLANATION);
    for (const folder of ["public", "assets-map"]) {
      for (const [path, bytes] of files(join(build, folder))) {
        for (const sentinel of [CORRECT, EXPLANATION, "SENTINEL-7f3a"]) expect(bytes.includes(sentinel), `${folder}/${path} has ${sentinel}`).toBe(false);
      }
    }
  });

  it("never reads, writes, or removes anything under private/, even with files that look like course data", async () => {
    const { course, build } = await everything();
    writeFileSync(join(build, "private", "marker.txt"), "marker");
    mkdirSync(join(build, "private", "assets"), { recursive: true });
    writeFileSync(join(build, "private", "assets", "sample-course"), "a file where a folder would be");
    const before = snapshot(join(build, "private"));

    expect(writeAssets(course, build)).toEqual([]);
    expect(writeAssets(assetCourse({}, undefined, { assets: null }), build)).toEqual([]);

    expect(snapshot(join(build, "private"))).toEqual(before);
  });

  it("is also true when the asset files themselves came from a folder named private/ or have private in the name", () => {
    const build = buildFolder();
    writeAssets(assetCourse({ "private/private.png": PNG, "private-key.png": PNG }), build);

    expect([...publicOf(build).keys()].sort()).toEqual([`private-${sha(PNG).slice(0, 16)}.png`, `private-key-${sha(PNG).slice(0, 16)}.png`]);
    expect(existsSync(join(build, "private"))).toBe(false);
  });
});

describe("the checked files from inspectCourse", () => {
  it("are what writeAssets writes", () => {
    const assets = inspectCourse(VALID_COURSE).assets;
    const build = buildFolder();
    writeAssets(VALID_COURSE, build);

    expect(assets?.files.map((file) => file.file)).toEqual(Object.values(mapOf(build).files as Record<string, { file: string }>).map((entry) => entry.file));
    expect(fixtureAsset("images/pic.png").equals(PNG)).toBe(true);
  });
});
