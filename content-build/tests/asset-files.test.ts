// The files in assets/: types, magic bytes, sizes, names, text files, and the warning for an unused file.

import { symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectCourse, validateCourse } from "../src/course.ts";
import { nameProblems } from "../src/asset-files.ts";
import { GLB, GLTF, JPG, PNG, SVG, VTT, WEBP, assetCourse, errorsOf, lessonWith, lines, mediaConfigFile } from "./asset-helpers.ts";
import { canCreate, makeCourse, temporaryFolder } from "./helpers.ts";

const ALLOWED = "the allowed types are .png, .jpg, .jpeg, .webp, .svg, .glb, .gltf, and .vtt";
const VIDEO_HINT = "videos are not kept in assets/: put them on the media CDN and use them with `Video`";

/** The errors of a course whose assets/ holds exactly `assets` (the lesson uses none of them). */
function check(assets: Record<string, string | Uint8Array>, mediaConfigPath?: string) {
  return errorsOf(validateCourse(assetCourse(assets), mediaConfigPath === undefined ? {} : { mediaConfigPath }));
}

/** The one problem of a single file, as `message`. */
function only(path: string, content: string | Uint8Array, mediaConfigPath?: string): string[] {
  return check({ [path]: content }, mediaConfigPath).map((problem) => `${problem.file}: ${problem.message}`);
}

describe("a course with nothing in assets/", () => {
  it("has no asset problems without an assets/ folder, with an empty one, and with only OS files", () => {
    const none = assetCourse({}, undefined, { assets: null });
    const empty = assetCourse({ "images/.keep-me/placeholder.txt": "x" }, undefined, { "assets/images": null });
    const osFiles = assetCourse({ ".DS_Store": "x", "Thumbs.db": "x", "images/.DS_Store": "x", "images/deep/Thumbs.db": "x" });

    expect(validateCourse(none)).toEqual([]);
    expect(validateCourse(empty)).toEqual([]);
    expect(validateCourse(osFiles)).toEqual([]);
  });

  it("allows subfolders", () => {
    expect(check({ "a/b/c/d.png": PNG })).toEqual([]);
  });
});

describe("file types", () => {
  it.each([
    ["pic.png", PNG],
    ["pic.jpg", JPG],
    ["pic.jpeg", JPG],
    ["pic.webp", WEBP],
    ["pic.svg", SVG],
    ["model.glb", GLB],
    ["model.gltf", GLTF],
    ["captions.vtt", VTT],
  ])("accepts %s", (name, content) => {
    expect(check({ [name]: content })).toEqual([]);
  });

  it.each(["PIC.PNG", "pic.Png", "pic.JPG", "pic.JPEG", "pic.WebP", "pic.SVG", "model.GLB", "model.GLTF", "c.VTT"])("accepts the extension of %s in any letter case", (name) => {
    const content = /png/i.test(name) ? PNG : /jpe?g/i.test(name) ? JPG : /webp/i.test(name) ? WEBP : /svg/i.test(name) ? SVG : /glb/i.test(name) ? GLB : /gltf/i.test(name) ? GLTF : VTT;

    expect(check({ [name]: content })).toEqual([]);
  });

  it.each(["notes.txt", "page.html", "data.json", "archive.zip", "model.bin", "pic.gif", "pic.bmp", "script.js", "README.md", "noextension", ".png", "pic.png.txt", "pic.tar.gz"])(
    "rejects %s and lists the allowed types",
    (name) => {
      const problems = check({ [name]: "x" });

      expect(problems).toHaveLength(name === ".png" ? 2 : 1);
      expect(problems.find((p) => p.message.startsWith("this file type"))).toEqual({
        severity: "error",
        file: `assets/${name}`,
        message: `this file type is not allowed in assets/; ${ALLOWED}`,
      });
    },
  );

  it.each(["mp4", "webm", "mov", "m4v", "ogv", "MP4", "Webm"])("tells the author that a .%s video goes on the media CDN", (extension) => {
    expect(check({ [`clips/intro.${extension}`]: "x" })).toEqual([
      { severity: "error", file: `assets/clips/intro.${extension}`, message: `this file type is not allowed in assets/; ${ALLOWED}; ${VIDEO_HINT}` },
    ]);
  });

  it("does not give the video hint for other types", () => {
    expect(only("notes.txt", "x")[0]).not.toContain("Video");
  });

  it("has no exemption for README.md in assets/", () => {
    expect(only("README.md", "Images go here.\n")).toEqual([`assets/README.md: this file type is not allowed in assets/; ${ALLOWED}`]);
  });

  it("checks every file once per course, whether or not a lesson uses it", () => {
    const course = assetCourse({ "unused/notes.txt": "x" });

    expect(errorsOf(validateCourse(course)).map((p) => p.file)).toEqual(["assets/unused/notes.txt"]);
  });
});

describe("magic bytes", () => {
  const WEBP_BAD = Buffer.concat([Buffer.from("RIFF"), WEBP.subarray(4, 8), Buffer.from("WAVE"), WEBP.subarray(12)]);

  it.each([
    ["png", PNG, "a PNG"],
    ["jpg", JPG, "a JPEG"],
    ["jpeg", JPG, "a JPEG"],
    ["webp", WEBP, "a WebP"],
    ["glb", GLB, "a binary glTF"],
  ])("accepts real .%s bytes and rejects text renamed to .%s", (extension, good, name) => {
    expect(only(`a.${extension}`, good)).toEqual([]);
    expect(only(`a.${extension}`, "<html>a page renamed</html>\n")).toEqual([
      `assets/a.${extension}: the file does not start like ${name} file, so it is not one (for example, a video or a web page renamed to .${extension})`,
    ]);
  });

  it("rejects a video renamed to .png", () => {
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(16)]);

    expect(only("clip.png", mp4)).toEqual([expect.stringContaining("does not start like a PNG file")]);
  });

  it("rejects a file that is too short for its signature, or whose signature is nearly right", () => {
    expect(only("a.png", PNG.subarray(0, 7))).toHaveLength(1);
    expect(only("a.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b]), PNG.subarray(8)]))).toHaveLength(1);
    expect(only("a.jpg", Buffer.from([0xff, 0xd8]))).toHaveLength(1);
    expect(only("a.jpg", Buffer.from([0xff, 0xd8, 0xfe, 0x00]))).toHaveLength(1);
    expect(only("a.glb", Buffer.from("glTX"))).toHaveLength(1);
    expect(only("a.webp", WEBP.subarray(0, 11))).toHaveLength(1);
  });

  it("checks both the RIFF and the WEBP markers of a WebP", () => {
    expect(only("a.webp", WEBP_BAD)).toHaveLength(1);
    expect(only("a.webp", Buffer.concat([Buffer.from("RIFX"), WEBP.subarray(4)]))).toHaveLength(1);
    expect(only("a.webp", WEBP)).toEqual([]);
  });

  it("accepts the .jpeg extension for the JPEG signature", () => {
    expect(only("a.jpeg", JPG)).toEqual([]);
  });

  it("looks at the bytes, not the letter case of the extension", () => {
    expect(only("a.PNG", "not a png")).toHaveLength(1);
  });
});

describe("empty files and sizes", () => {
  it.each(["a.png", "a.jpg", "a.webp", "a.svg", "a.glb", "a.gltf", "a.vtt"])("rejects an empty %s", (name) => {
    expect(only(name, "")).toEqual([`assets/${name}: the file is empty (0 bytes)`]);
  });

  // Limits 100, 200, and 50 bytes keep the files small; the committed config is checked below.
  const small = () => mediaConfigFile({ assetLimits: { imageBytes: 100, modelBytes: 200, captionBytes: 50 } });
  const padded = (head: Uint8Array, size: number) => Buffer.concat([head, Buffer.alloc(size - head.length)]);

  it.each([
    ["a.png", PNG.subarray(0, 8), 100, "100 bytes"],
    ["a.jpg", Buffer.from([0xff, 0xd8, 0xff]), 100, "100 bytes"],
    ["a.jpeg", Buffer.from([0xff, 0xd8, 0xff]), 100, "100 bytes"],
    ["a.webp", Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBP")]), 100, "100 bytes"],
    ["a.glb", Buffer.from("glTF"), 200, "200 bytes"],
  ])("accepts %s of exactly the limit and rejects one byte more", (name, head, limit, shown) => {
    const config = small();

    expect(only(name, padded(head, limit), config)).toEqual([]);
    expect(only(name, padded(head, limit + 1), config)).toEqual([
      `assets/${name}: the file is ${limit + 1} bytes, but the most allowed for a .${name.split(".")[1]} file is ${shown}`,
    ]);
  });

  it("applies the image limit to .svg, the model limit to .gltf, and the caption limit to .vtt", () => {
    const config = small();
    const svgBase = '<svg xmlns="http://www.w3.org/2000/svg"><!----></svg>';
    const svg = (size: number) => svgBase.replace("<!---->", `<!--${"x".repeat(size - svgBase.length)}-->`);
    const gltfBase = '{"asset":{"version":"2.0"},"pad":""}';
    const gltf = (size: number) => gltfBase.replace('""', `"${"x".repeat(size - gltfBase.length)}"`);
    const vtt = (size: number) => `WEBVTT\n${"x".repeat(size - 7)}`;

    expect(Buffer.byteLength(svg(100))).toBe(100);
    expect(only("a.svg", svg(100), config)).toEqual([]);
    expect(only("a.svg", svg(101), config)).toEqual([expect.stringContaining("the file is 101 bytes, but the most allowed for a .svg file is 100 bytes")]);
    expect(Buffer.byteLength(gltf(200))).toBe(200);
    expect(only("a.gltf", gltf(200), config)).toEqual([]);
    expect(only("a.gltf", gltf(201), config)).toEqual([expect.stringContaining("the file is 201 bytes, but the most allowed for a .gltf file is 200 bytes")]);
    expect(only("a.vtt", vtt(50), config)).toEqual([]);
    expect(only("a.vtt", vtt(51), config)).toEqual([expect.stringContaining("the file is 51 bytes, but the most allowed for a .vtt file is 50 bytes")]);
  });

  it("measures the size on disk: a CRLF file counts its CR bytes", () => {
    const config = mediaConfigFile({ assetLimits: { imageBytes: 100, modelBytes: 200, captionBytes: 30 } });
    const lf = "WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n"; // 34 bytes
    const small = "WEBVTT\n\n00:00.000 --> 00:01.0\n"; // 30 bytes

    expect(only("a.vtt", small, config)).toEqual([]);
    expect(only("a.vtt", small.replaceAll("\n", "\r\n"), config)).toHaveLength(1);
    expect(only("a.vtt", lf, config)).toHaveLength(1);
  });

  it("uses the limits of the committed config: 5 MiB for images, 25 MiB for models, 1 MiB for captions", () => {
    const MiB = 1024 * 1024;
    const course = assetCourse({ "ok.png": PNG });
    const assets = join(course, "assets");
    // Sparse files of the exact limit and one byte more; the oversized ones are never read.
    const sparse = (name: string, size: number, head: Uint8Array) => {
      writeFileSync(join(assets, name), head);
      truncateSync(join(assets, name), size);
    };
    sparse("big.png", 5 * MiB + 1, PNG);
    sparse("big.jpg", 5 * MiB + 1, JPG);
    sparse("big.webp", 5 * MiB + 1, WEBP);
    sparse("big.glb", 25 * MiB + 1, GLB);
    sparse("big.vtt", MiB + 1, Buffer.from("WEBVTT\n"));
    sparse("edge.png", 5 * MiB, PNG);
    sparse("edge.glb", 25 * MiB, GLB);
    writeFileSync(join(assets, "edge.vtt"), `WEBVTT\n${"x".repeat(MiB - 7)}`);

    const problems = errorsOf(validateCourse(course));

    expect(problems.map((p) => p.file)).toEqual(["assets/big.glb", "assets/big.jpg", "assets/big.png", "assets/big.vtt", "assets/big.webp"]);
    expect(problems.map((p) => p.message.replace(/^the file is (\d+) bytes, but the most allowed for a (\.\w+) file is /, "$1 $2 limit "))).toEqual([
      `${25 * MiB + 1} .glb limit ${25 * MiB} bytes (25 MiB)`,
      `${5 * MiB + 1} .jpg limit ${5 * MiB} bytes (5 MiB)`,
      `${5 * MiB + 1} .png limit ${5 * MiB} bytes (5 MiB)`,
      `${MiB + 1} .vtt limit ${MiB} bytes (1 MiB)`,
      `${5 * MiB + 1} .webp limit ${5 * MiB} bytes (5 MiB)`,
    ]);
  });
});

/** The names that a URL would need to encode: each is one case of the rule, run on path strings and on disk. */
const URL_NAMES: [string, string][] = [
  ["a space", "my pic.png"],
  ["a percent sign", "a%b.png"],
  ["a number sign", "a#b.png"],
  ["a question mark", "a?b.png"],
  ["an ampersand", "a&b.png"],
  ["a plus sign", "a+b.png"],
  ["a tilde", "a~b.png"],
  ["a parenthesis", "a(b).png"],
  ["a non-ASCII letter", "café.png"],
  ["a leading dot", ".hidden.png"],
  ["a comma", "a,b.png"],
  ["an apostrophe", "it's.png"],
];
const URL_NAME_MESSAGE = "the name may use only letters, digits, `.`, `_`, and `-`, and may not start with `.`, so that a path never needs URL-encoding";

/** The names that Windows cannot extract: the rule, and the kind of message it gives. */
const WINDOWS_NAMES: [string, string, RegExp][] = [
  ["a device name", "CON.png", /Windows does not allow|device name/],
  ["a device name with an extension, in a folder", "nul.dir/x.png", /device name/],
  ["COM1", "com1.png", /device name/],
  ["a trailing space", "pic.png ", /ends with a space or a dot/],
  ["a trailing dot", "pic.png.", /ends with a space or a dot/],
  ["a colon", "a:b.png", /character that Windows does not allow/],
  ["a question mark", "a?b.png", /character that Windows does not allow/],
];

/** The problems `nameProblems` gives for these paths, as `path: message`; no file is read or written. */
function nameProblemLines(...paths: string[]): string[] {
  const found: string[] = [];
  nameProblems(paths, (path, message) => found.push(`${path}: ${message}`));
  return found;
}

describe("names, checked on path strings (the same on every platform)", () => {
  it.each(URL_NAMES)("rejects %s in a file name, naming the file", (_name, name) => {
    expect(nameProblemLines(name).filter((line) => line.includes("the name may use only"))).toEqual([`${name}: ${URL_NAME_MESSAGE}`]);
  });

  it.each(WINDOWS_NAMES)("rejects %s, as windowsPathProblems does for code", (_name, path, message) => {
    const found = nameProblemLines(path).filter((line) => message.test(line));

    expect(found.length).toBeGreaterThanOrEqual(1);
    // Each names the file or a folder on its way, never another path.
    expect(found.every((line) => path.startsWith(line.slice(0, line.indexOf(": "))))).toBe(true);
  });

  it("returns the paths it reported, once each, and the shortest path for a folder", () => {
    const reported = nameProblems(["my folder/a.png", "my folder/b.png", "ok/fine.png", "ok/a:b.png"], () => {});

    expect([...reported].sort()).toEqual(["my folder", "ok/a:b.png"]);
  });
});

describe("names", () => {
  // These write the file, so they run where the file system can create the name; the same rule is run on strings above.
  for (const [what, name] of URL_NAMES) {
    it.skipIf(!canCreate(name))(`rejects ${what} in a file name on disk, naming the file [needs a file system that can create the name]`, () => {
      expect(only(name, PNG).filter((message) => message.includes("the name may use only"))).toEqual([`assets/${name}: ${URL_NAME_MESSAGE}`]);
    });
  }

  it("names the shortest path that has the problem: the folder, not the files under it", () => {
    const problems = check({ "my folder/a.png": PNG, "my folder/b.png": PNG, "my folder/deeper/c.png": PNG });

    expect(problems.map((p) => p.file)).toEqual(["assets/my folder"]);
  });

  it("names a bad file inside a good folder, and each bad name once", () => {
    const problems = check({ "images/my pic.png": PNG, "images/ok.png": PNG, "bad one/x y/z.png": PNG });

    expect(problems.map((p) => p.file)).toEqual(["assets/bad one", "assets/bad one/x y", "assets/images/my pic.png"]);
  });

  it.each(["pic.png", "a_b-c.png", "_x.png", "-x.png", "1.png", "a.b.c.png", "A-Z_0-9.png", "x/y/z.png", "v1.2/pic.png"])("accepts the name %s", (path) => {
    expect(check({ [path]: PNG })).toEqual([]);
  });

  for (const [what, path, message] of WINDOWS_NAMES) {
    it.skipIf(!canCreate(path))(`rejects ${what} on disk, as windowsPathProblems does for code [needs a file system that can create the name]`, () => {
      const found = check({ [path]: PNG }).filter((p) => message.test(p.message));

      expect(found.length).toBeGreaterThanOrEqual(1);
      expect(found.every((p) => p.file.startsWith("assets/"))).toBe(true);
    });
  }

  it("rejects a path of more than 100 characters from assets/, and accepts 100", () => {
    const path = (length: number) => `${"d".repeat(40)}/${"e".repeat(40)}/${"f".repeat(length - 86)}.png`;

    expect(path(100)).toHaveLength(100);
    expect(check({ [path(100)]: PNG })).toEqual([]);
    expect(check({ [path(101)]: PNG }).map((p) => p.message)).toEqual([
      "this path cannot be extracted on Windows: it is 101 characters long and the most allowed is 100",
    ]);
  });

  const caseSensitive = (() => {
    const folder = temporaryFolder();
    writeFileSync(join(folder, "a"), "1");
    writeFileSync(join(folder, "A"), "2");
    return true;
  })();

  it.skipIf(process.platform === "win32" || process.platform === "darwin" || !caseSensitive)("rejects two names in one folder that differ only in letter case", () => {
    const problems = check({ "images/pic.png": PNG, "images/Pic.png": PNG });

    expect(problems.map((p) => p.file)).toEqual(["assets/images/Pic.png", "assets/images/pic.png"]);
    expect(problems.every((p) => p.message.includes("differs only in letter case"))).toBe(true);
  });

  it.skipIf(process.platform === "win32" || process.platform === "darwin")("rejects two files whose flat output names differ only in letter case", () => {
    const problems = check({ "a/Pic.png": PNG, "b/pic.png": PNG });

    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("differs only in letter case from `Pic-");
  });
});

describe("links and other entries", () => {
  const link = it.skipIf(process.platform === "win32");

  link("rejects a symbolic link to a file and never reads through it", () => {
    const outside = join(temporaryFolder(), "outside-sentinel.png");
    writeFileSync(outside, "LINK-SENTINEL-4d2c");
    const course = assetCourse({ "real.png": PNG });
    symlinkSync(outside, join(course, "assets", "link.png"));

    const problems = errorsOf(validateCourse(course));

    expect(problems).toEqual([
      { severity: "error", file: "assets/link.png", message: "this is not a plain file or folder (for example, a symbolic link), and the build never follows links" },
    ]);
    expect(JSON.stringify(problems)).not.toContain("LINK-SENTINEL");
  });

  link("says a reference to a symbolic link is not a plain file", () => {
    const outside = join(temporaryFolder(), "outside.png");
    writeFileSync(outside, PNG);
    const course = assetCourse({ "real.png": PNG }, lessonWith('<Image src="link.png" alt="A" />'));
    symlinkSync(outside, join(course, "assets", "link.png"));

    // Sorted by file: the link in assets/ first, then the lesson.
    expect(errorsOf(validateCourse(course)).map((p) => p.message)).toEqual([
      "this is not a plain file or folder (for example, a symbolic link), and the build never follows links",
      "the prop `src` of `<Image>`: `link.png` is not a plain file",
    ]);
  });

  link("rejects a symbolic link to a folder, and does not go into it", () => {
    const outside = temporaryFolder();
    writeFileSync(join(outside, "inside.txt"), "x");
    const course = assetCourse({ "real.png": PNG });
    symlinkSync(outside, join(course, "assets", "folder"));

    expect(errorsOf(validateCourse(course)).map((p) => p.file)).toEqual(["assets/folder"]);
  });

  link("rejects assets/ itself when it is a symbolic link", () => {
    const outside = temporaryFolder();
    writeFileSync(join(outside, "a.png"), PNG);
    const course = assetCourse({}, undefined, { assets: null });
    symlinkSync(outside, join(course, "assets"));

    expect(errorsOf(validateCourse(course)).map((p) => [p.file, p.message])).toEqual([
      ["assets", "this is not a plain folder (for example, a symbolic link), and the build never follows links"],
    ]);
  });
});

describe("folders nested very deeply", () => {
  it("are an error at 32 levels, and what is inside is not checked", () => {
    const levels = (count: number) => Array.from({ length: count }, () => "d").join("/");
    const course = assetCourse({ [`${levels(31)}/ok.png`]: PNG, [`${levels(32)}/notes.txt`]: "x" });

    expect(errorsOf(validateCourse(course)).map((p) => [p.file, p.message])).toEqual([
      [`assets/${levels(32)}`, "folders may be nested at most 32 levels deep, so what is inside this folder is not checked"],
    ]);
  });
});

describe("captions (.vtt)", () => {
  it("accepts a file with WEBVTT first, with or without a byte order mark, and with LF, CRLF, or CR line endings", () => {
    expect(only("a.vtt", VTT)).toEqual([]);
    expect(only("a.vtt", `\uFEFF${VTT}`)).toEqual([]);
    expect(only("a.vtt", VTT.replaceAll("\n", "\r\n"))).toEqual([]);
    expect(only("a.vtt", VTT.replaceAll("\n", "\r"))).toEqual([]);
    expect(only("a.vtt", "WEBVTT")).toEqual([]);
  });

  it("rejects a file that does not start with WEBVTT, at line 1", () => {
    const problems = check({ "a.vtt": "\n\nWEBVTT\n" });

    expect(problems).toEqual([{ severity: "error", file: "assets/a.vtt", line: 1, message: "a .vtt file must start with `WEBVTT` (after an optional byte order mark)" }]);
    expect(only("b.vtt", " WEBVTT\n")).toHaveLength(1);
    expect(only("b.vtt", "webvtt\n")).toHaveLength(1);
    expect(only("b.vtt", "1\n00:00 --> 00:01\nHi\n")).toHaveLength(1);
  });

  it("rejects a NUL character", () => {
    expect(only("a.vtt", `${VTT}\u0000`)).toEqual(["assets/a.vtt: the file contains a NUL character, so it is not text"]);
  });

  it("rejects bytes that are not UTF-8, such as UTF-16 and Latin-1", () => {
    expect(only("a.vtt", Buffer.from(`\uFEFF${VTT}`, "utf16le"))).toEqual(["assets/a.vtt: the file is not valid UTF-8 text"]);
    expect(only("b.vtt", Buffer.from(`${VTT}café`, "latin1"))).toEqual(["assets/b.vtt: the file is not valid UTF-8 text"]);
  });
});

describe("models (.gltf)", () => {
  const gltf = (value: unknown) => JSON.stringify(value);
  const data = "data:application/octet-stream;base64,AAAA";

  it("accepts JSON whose buffers and images are data: URIs, or have no uri", () => {
    expect(only("a.gltf", gltf({ asset: { version: "2.0" }, buffers: [{ byteLength: 3, uri: data }], images: [{ uri: "data:image/png;base64,AAAA" }, { bufferView: 0 }] }))).toEqual([]);
    expect(only("b.gltf", gltf({ asset: { version: "2.0" } }))).toEqual([]);
    expect(only("c.gltf", gltf({ buffers: [{ uri: "DATA:text/plain,x" }] }))).toEqual([]);
    expect(only("d.gltf", GLTF)).toEqual([]);
  });

  it("rejects text that is not JSON, and JSON that is not an object", () => {
    expect(only("a.gltf", "not json")).toEqual(["assets/a.gltf: a .gltf file must be JSON text, but this is not valid JSON"]);
    expect(only("b.gltf", "[]")).toEqual(["assets/b.gltf: a .gltf file must hold one JSON object"]);
    expect(only("c.gltf", "null")).toEqual(["assets/c.gltf: a .gltf file must hold one JSON object"]);
  });

  it.each([
    ["an outside buffer file", { buffers: [{ uri: "box.bin" }] }, "`buffers[0]` points to an outside file `box.bin`"],
    ["an outside image file", { images: [{ uri: "tex/wood.png" }] }, "`images[0]` points to an outside file `tex/wood.png`"],
    ["a second buffer that is outside", { buffers: [{ uri: data }, { uri: "b.bin" }] }, "`buffers[1]` points to an outside file `b.bin`"],
    ["an address", { images: [{ uri: "https://example.com/x.png" }] }, "`images[0]` points to an outside file `https://example.com/x.png`"],
    ["a uri that only looks like data:", { buffers: [{ uri: "xdata:,x" }] }, "`buffers[0]` points to an outside file `xdata:,x`"],
    ["a uri that is not a string", { buffers: [{ uri: 5 }] }, "`buffers[0]` points to an outside file"],
  ])("rejects %s and says to embed it or use .glb", (_name, json, message) => {
    expect(only("a.gltf", gltf(json))).toEqual([`assets/a.gltf: ${message}; embed it as a data: URI, or use a .glb file`]);
  });

  it("rejects a .gltf that is not UTF-8", () => {
    expect(only("a.gltf", Buffer.from(gltf({ name: "café" }), "latin1"))).toEqual(["assets/a.gltf: the file is not valid UTF-8 text"]);
    expect(only("b.gltf", Buffer.from(`\uFEFF${gltf({})}`, "utf16le"))).toEqual(["assets/b.gltf: the file is not valid UTF-8 text"]);
  });

  it("accepts a byte order mark and CRLF line endings", () => {
    expect(only("a.gltf", `\uFEFF{\r\n"asset": {"version": "2.0"}\r\n}`)).toEqual([]);
  });
});

describe("SVG files in assets/", () => {
  it("reports an SVG rule with the line of its first match, on assets/<path>", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg">\n<title>a</title>\n<script>alert(1)</script>\n</svg>\n';

    expect(check({ "diagrams/a.svg": svg })).toEqual([
      {
        severity: "error",
        file: "assets/diagrams/a.svg",
        line: 3,
        message: "the SVG has a `<script>` element, which can run code, load a page, or animate; remove it",
      },
    ]);
  });

  it("counts lines the same for CRLF and CR files, and after a byte order mark", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg">\n<title>a</title>\n<script/>\n</svg>\n';

    for (const text of [svg, svg.replaceAll("\n", "\r\n"), svg.replaceAll("\n", "\r"), `\uFEFF${svg}`]) {
      expect(check({ "a.svg": text }).map((p) => p.line)).toEqual([3]);
    }
  });

  it("rejects an SVG that is not UTF-8, such as UTF-16, and one with a NUL character (also as the fixtures asset-svg-not-utf8 and asset-svg-nul)", () => {
    expect(only("a.svg", Buffer.from(`\uFEFF${SVG}`, "utf16le"))).toEqual(["assets/a.svg: the file is not valid UTF-8 text"]);
    expect(only("b.svg", Buffer.from(SVG.replace("<svg", "<svg\u0000"), "utf8"))).toEqual([expect.stringContaining("contains a NUL character")]);
    expect(only("c.svg", SVG.replace("<svg", '<?xml version="1.0" encoding="UTF-16"?><svg'))).toEqual([expect.stringContaining("encoding is `UTF-16`")]);
  });

  it("rejects a file with no <svg start tag", () => {
    expect(check({ "a.svg": "<html></html>" })).toEqual([
      { severity: "error", file: "assets/a.svg", line: 1, message: "there is no `<svg` start tag, so this is not an SVG" },
    ]);
  });

  it("accepts the SVGs of the valid fixture", () => {
    expect(check({ "a.svg": SVG })).toEqual([]);
  });
});

describe("unused files", () => {
  const used = lessonWith('<Image src="images/used.png" alt="A picture" />');

  it("warns on assets/<path>, with no line, about a file that no lesson uses", () => {
    const course = assetCourse({ "images/used.png": PNG, "images/unused.png": PNG, "models/m.glb": GLB }, used);

    expect(validateCourse(course)).toEqual([
      { severity: "warning", file: "assets/images/unused.png", message: "no lesson uses this file; use it in a lesson or remove it" },
      { severity: "warning", file: "assets/models/m.glb", message: "no lesson uses this file; use it in a lesson or remove it" },
    ]);
  });

  it("counts a Model3D poster, a Video poster, and Video captions as use", () => {
    const body = [
      '<Model3D src="models/m.glb" alt="A model" poster="images/model-poster.png" />',
      '<Video src="https://media.mcp-lab.example/a.mp4" title="A video" captions="captions/c.vtt" poster="images/video-poster.png" />',
      '<Diagram src="diagrams/d.svg" alt="A diagram" />',
      "![A picture](images/md.png)",
    ].join("\n\n");
    const course = assetCourse(
      { "models/m.glb": GLB, "images/model-poster.png": PNG, "captions/c.vtt": VTT, "images/video-poster.png": PNG, "diagrams/d.svg": SVG, "images/md.png": PNG },
      lessonWith(body),
    );

    expect(validateCourse(course)).toEqual([]);
  });

  it("does not warn about a file that has an error of its own", () => {
    const course = assetCourse({ "images/used.png": PNG, "notes.txt": "x", "bad.png": "not a png", "my pic.png": PNG }, used);

    expect(validateCourse(course).filter((p) => p.severity === "warning")).toEqual([]);
  });

  it("gives no warning when a lesson has a problem, because its references are not known", () => {
    const base = { "images/used.png": PNG, "images/unused.png": PNG };
    const broken = [
      lessonWith('<Image src="images/used.png" alt="A picture" />\n\n{1 + 1}'),
      lessonWith('<Image src="images/missing.png" alt="A picture" />'),
      lessonWith("<Callout>"),
    ];

    for (const lesson of broken) {
      const problems = validateCourse(assetCourse(base, lesson));
      expect(problems.some((p) => p.severity === "error")).toBe(true);
      expect(problems.filter((p) => p.severity === "warning")).toEqual([]);
    }
  });

  it("gives no warning when another lesson of the course has a problem", () => {
    const first = "chapters/01-first-steps/lessons/01-welcome.mdx";
    const course = assetCourse({ "images/unused.png": PNG }, undefined, { [first]: lessonWith("{1 + 1}") });

    expect(validateCourse(course).filter((p) => p.severity === "warning")).toEqual([]);
  });

  it("gives no warning when a lesson cannot be compiled because its front matter is missing", () => {
    const course = assetCourse({ "images/unused.png": PNG }, "# No front matter\n");

    expect(validateCourse(course).filter((p) => p.severity === "warning")).toEqual([]);
  });

  it("gives no warning when course.yaml has no usable chapters", () => {
    const course = assetCourse({ "images/unused.png": PNG }, undefined, { "course.yaml": "id: sample-course\ntitle: A\ndescription: B\nchapters: []\n" });

    expect(validateCourse(course).filter((p) => p.severity === "warning")).toEqual([]);
  });

  it("does not run for inspectCourse without the lessons: the files are checked, nothing is warned", () => {
    const course = assetCourse({ "images/unused.png": PNG });

    expect(inspectCourse(course).problems).toEqual([]);
  });
});

describe("inspectCourse().assets", () => {
  it("gives the checked files: path, hashed name, sha256, size, and the bytes that are written", () => {
    const course = assetCourse({ "images/pic.png": PNG, "captions/c.vtt": `\uFEFF${VTT.replaceAll("\n", "\r\n")}` });
    const assets = inspectCourse(course).assets;

    expect(assets?.courseId).toBe("sample-course");
    expect(assets?.problems).toEqual([]);
    expect(assets?.files.map(({ path, file, size }) => ({ path, file: file.replace(/-[0-9a-f]{16}\./, "-HASH."), size }))).toEqual([
      { path: "captions/c.vtt", file: "c-HASH.vtt", size: Buffer.byteLength(VTT) },
      { path: "images/pic.png", file: "pic-HASH.png", size: PNG.length },
    ]);
    expect(Buffer.from(assets?.files[0]?.data ?? []).toString("utf8")).toBe(VTT);
  });

  it("is empty, with no problems, for a course without assets/", () => {
    const assets = inspectCourse(assetCourse({}, undefined, { assets: null })).assets;

    expect(assets).toMatchObject({ problems: [], files: [] });
  });

  it("is undefined when the course folder cannot be read", () => {
    expect(inspectCourse(join(temporaryFolder(), "missing")).assets).toBeUndefined();
  });

  it("keeps the problems of #7, #8, #10, and #11 and adds the asset problems, sorted by file", () => {
    const course = makeCourse("sample-course", { "assets/notes.txt": "x", "extra.txt": "x" });

    expect(lines(validateCourse(course))).toEqual([
      `error assets/notes.txt this file type is not allowed in assets/; ${ALLOWED}`,
      "warning extra.txt this file is not part of the course format and is ignored",
    ]);
  });
});
