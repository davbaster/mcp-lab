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
const { PNG, NEXT, assetCourse, lessonWith } = await import("./asset-helpers.ts");
const { temporaryFolder } = await import("./helpers.ts");

/** The paths that were read (or asked about), without the writes the test itself does to set up. */
const reads = () => opened.filter((call) => call.startsWith("read ")).map((call) => call.slice("read ".length));

describe("an asset path never opens a file outside assets/", () => {
  it("does not open the sentinel files that `..` and absolute paths point to, and does not show their content", () => {
    const course = assetCourse({ "images/pic.png": PNG });
    const inCourse = join(course, "NEXT-TO-ASSETS-sentinel-5e1f.png");
    const aboveCourse = join(course, "..", "ABOVE-COURSE-sentinel-5e1f.png");
    const elsewhere = join(temporaryFolder(), "ELSEWHERE-sentinel-5e1f.png");
    for (const file of [inCourse, aboveCourse, elsewhere]) writeFileSync(file, "SENTINEL-CONTENT-8a7b");
    mkdirSync(join(course, "assets", "sub"));

    const values = [
      "../NEXT-TO-ASSETS-sentinel-5e1f.png",
      "../../ABOVE-COURSE-sentinel-5e1f.png",
      "sub/../../NEXT-TO-ASSETS-sentinel-5e1f.png",
      "..\\NEXT-TO-ASSETS-sentinel-5e1f.png",
      "./../NEXT-TO-ASSETS-sentinel-5e1f.png",
      elsewhere,
      "/etc/passwd",
      "assets/../NEXT-TO-ASSETS-sentinel-5e1f.png",
      "images/pic.png/../../../NEXT-TO-ASSETS-sentinel-5e1f.png",
    ];
    const body = values.map((value, i) => `<Image src="${value.replaceAll("\\", "\\\\")}" alt="Case ${i}" />`).join("\n\n");
    writeFileSync(join(course, NEXT), lessonWith(body));
    const markdown = values.map((value) => `![A](${value.replaceAll("\\", "/")})`).join("\n\n");
    writeFileSync(join(course, "chapters/01-first-steps/lessons/01-welcome.mdx"), lessonWith(markdown));
    opened.length = 0;

    const problems = validateCourse(course);

    expect(problems.filter((p) => p.severity === "error").length).toBeGreaterThanOrEqual(values.length);
    expect(JSON.stringify(problems)).not.toContain("SENTINEL-CONTENT-8a7b");
    // The recording works: the lessons and the assets were opened.
    expect(reads().some((path) => path.endsWith("01-next.mdx"))).toBe(true);
    expect(reads().some((path) => path.endsWith("pic.png"))).toBe(true);
    // And nothing was opened for a path that a lesson typed.
    expect(reads().filter((path) => /sentinel-5e1f/i.test(path))).toEqual([]);
    expect(reads().filter((path) => path.includes("passwd"))).toEqual([]);
    expect(reads().filter((path) => path.includes("ELSEWHERE"))).toEqual([]);
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
