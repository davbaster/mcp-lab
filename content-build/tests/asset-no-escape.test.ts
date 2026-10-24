// Nothing outside assets/ is read because of an asset path in a lesson.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const opened = vi.hoisted(() => [] as string[]);

// Every path that the build asks the file system about is recorded; the real functions still run.
vi.mock("node:fs", async (importOriginal) => {
  const { recordingFs } = await import("./fs-recorder.ts");
  return recordingFs(await importOriginal<typeof import("node:fs")>(), opened);
});

const { validateCourse } = await import("../src/course.ts");
const { PNG, NEXT, assetCourse, errorsOf, lessonWith } = await import("./asset-helpers.ts");
const { temporaryFolder } = await import("./helpers.ts");

/** The paths that were read (or asked about), without the writes the test itself does to set up. */
const reads = () => opened.filter((call) => call.startsWith("read ")).map((call) => call.slice("read ".length));

const SLASH = "the path starts with a slash; write it relative to assets/, as in `images/pic.png`";
const BACKSLASH = "the path has a backslash; separate folders with `/`";
const DOTS = "the path has a `.` or `..` part; write the path from assets/ down, without leaving it";
const BAD_NAME =
  "the path has a name with a character that file names in assets/ may not have; only letters, digits, `.`, `_`, and `-` are allowed, and a name may not start with `.`";
const scheme = (name: string) => `the URL scheme \`${name}\` is not allowed; use http, https, mailto, or a relative URL`;

/** What each form says: a URL that the lesson check rejects (the lesson does not compile), or a path that the reference check rejects. */
const urlRule = (message: string) => ({ markdown: `image: ${message}`, component: `the prop \`src\` of \`<Image>\`: ${message}` });
const pathRule = (message: string) => ({ markdown: `the Markdown image: ${message}`, component: `the prop \`src\` of \`<Image>\`: ${message}` });

// Each value gets its own course. A value that is a URL (a drive letter `C:` is read as a scheme) makes its lesson not compile,
// and a lesson that does not compile has no reference check; with all values in one lesson, that one would hide the rest.
const values: [string, { markdown: string; component: string }][] = [
  ["../NEXT-TO-ASSETS-sentinel-5e1f.png", pathRule(DOTS)],
  ["../../ABOVE-COURSE-sentinel-5e1f.png", pathRule(DOTS)],
  ["sub/../../NEXT-TO-ASSETS-sentinel-5e1f.png", pathRule(DOTS)],
  ["..\\NEXT-TO-ASSETS-sentinel-5e1f.png", pathRule(BACKSLASH)],
  ["./../NEXT-TO-ASSETS-sentinel-5e1f.png", pathRule(DOTS)],
  ["/etc/passwd", pathRule(SLASH)],
  ["assets/../NEXT-TO-ASSETS-sentinel-5e1f.png", pathRule(DOTS)],
  ["images/pic.png/../../../NEXT-TO-ASSETS-sentinel-5e1f.png", pathRule(DOTS)],
  // Windows-style values, as fixed strings (not the temp path, which can hold a space or a `#`).
  ["C:\\Users\\John Smith\\AppData\\Local\\Temp\\ELSEWHERE-sentinel-5e1f.png", urlRule(scheme("C:"))],
  ["C:\\x.png", urlRule(scheme("C:"))],
  ["C:/x.png", urlRule(scheme("C:"))],
  ["c:x.png", urlRule(scheme("c:"))],
  ["\\\\server\\share\\x.png", urlRule("a URL that starts with `//` is not allowed; write the whole http or https address, or a path that starts with one `/`")],
  ["\\x.png", pathRule(SLASH)],
  ["/C:/x.png", pathRule(SLASH)],
  ["..\\x.png", pathRule(BACKSLASH)],
  ["images\\..\\..\\x.png", pathRule(BACKSLASH)],
  ["images/pic.png:stream", pathRule(BAD_NAME)],
  ["images/CON.png", pathRule("there is no file `images/CON.png` in assets/")],
  ["file:///C:/x.png", urlRule(scheme("file:"))],
];

describe("an asset path never opens a file outside assets/", () => {
  /** The sentinel files that the values point to, written where a real escape would find them. */
  function course() {
    const course = assetCourse({ "images/pic.png": PNG });
    const inCourse = join(course, "NEXT-TO-ASSETS-sentinel-5e1f.png");
    const aboveCourse = join(course, "..", "ABOVE-COURSE-sentinel-5e1f.png");
    const elsewhere = join(temporaryFolder(), "ELSEWHERE-sentinel-5e1f.png");
    for (const file of [inCourse, aboveCourse, elsewhere]) writeFileSync(file, "SENTINEL-CONTENT-8a7b");
    mkdirSync(join(course, "assets", "sub"));
    return { course, elsewhere };
  }

  /** The two lessons that use `value`: as a component prop (JSX strings have no escapes) and as a Markdown image (`\\` is an escape, and `<...>` allows a space). */
  function useValue(courseFolder: string, value: string) {
    writeFileSync(join(courseFolder, NEXT), lessonWith(`<Image src="${value}" alt="A" />`));
    writeFileSync(join(courseFolder, "chapters/01-first-steps/lessons/01-welcome.mdx"), lessonWith(`![A](<${value.replaceAll("\\", "\\\\")}>)`));
  }

  /** What the build did with `value`, and the assertions that no file outside assets/ was opened. */
  function expectNothingOpened(problems: readonly unknown[]) {
    expect(JSON.stringify(problems)).not.toContain("SENTINEL-CONTENT-8a7b");
    // The recording works: the lessons and the assets were opened.
    expect(reads().some((path) => path.endsWith("01-next.mdx"))).toBe(true);
    expect(reads().some((path) => path.endsWith("pic.png"))).toBe(true);
    // And nothing was opened for a path that a lesson typed.
    expect(reads().filter((path) => /sentinel-5e1f/i.test(path))).toEqual([]);
    expect(reads().filter((path) => path.includes("passwd"))).toEqual([]);
    expect(reads().filter((path) => path.includes("ELSEWHERE"))).toEqual([]);
  }

  it.each(values)("rejects %j, says why in both lessons, and does not open the sentinel files", (value, expected) => {
    const { course: folder } = course();
    useValue(folder, value);
    opened.length = 0;

    // The sentinel file next to assets/ is a stray file of the course, which is a warning; only the errors are the subject here.
    const problems = errorsOf(validateCourse(folder));

    expect(problems.map((p) => ({ file: p.file.split("/").slice(-1)[0], message: p.message }))).toEqual([
      { file: "01-welcome.mdx", message: expected.markdown },
      { file: "01-next.mdx", message: expected.component },
    ]);
    expectNothingOpened(problems);
  });

  it("rejects the real path of a file outside the course, whatever form this platform gives it, and does not open it", () => {
    const { course: folder, elsewhere } = course();
    useValue(folder, elsewhere);
    opened.length = 0;

    // The sentinel file next to assets/ is a stray file of the course, which is a warning; only the errors are the subject here.
    const problems = errorsOf(validateCourse(folder));

    // `/tmp/...` is a rooted path; `C:\...` is read as a URL with the scheme `C:`.
    const expected = elsewhere.startsWith("/") ? pathRule(SLASH) : urlRule(scheme(`${elsewhere.slice(0, 2)}`));
    expect(problems.map((p) => p.message)).toEqual([expected.markdown, expected.component]);
    expectNothingOpened(problems);
  });

  it("opens only files inside the course, the component schemas, and the media config", () => {
    const course = assetCourse({ "images/pic.png": PNG }, lessonWith('<Image src="images/pic.png" alt="A" />'));
    opened.length = 0;

    validateCourse(course);

    // The listing of the course's parent folder finds how the course folder is spelled on disk (#7).
    const outside = reads().filter(
      (path) => !path.startsWith(course) && path !== dirname(course) && !path.includes("content-components") && !path.endsWith("media-config.json"),
    );
    expect(outside).toEqual([]);
  });
});
