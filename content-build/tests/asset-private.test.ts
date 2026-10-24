// writeAssets never reads, writes, or removes anything under private/, and writes only its own two places.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);

vi.mock("node:fs", async (importOriginal) => {
  const { recordingFs } = await import("./fs-recorder.ts");
  return recordingFs(await importOriginal<typeof import("node:fs")>(), calls);
});

const { writeAssets } = await import("../src/index.ts");
const { VALID_COURSE, temporaryFolder } = await import("./helpers.ts");
const { PNG, assetCourse } = await import("./asset-helpers.ts");

describe("writeAssets and private/", () => {
  it("does not ask the file system about any path under <buildDir>/private/, and writes only public/assets/<course_id>/ and the map", () => {
    const build = join(temporaryFolder(), "build");
    calls.length = 0;

    expect(writeAssets(VALID_COURSE, build)).toEqual([]);

    const root = resolve(build);
    const buildCalls = calls.filter((call) => call.slice(call.indexOf(" ") + 1).startsWith(root));
    const writes = buildCalls.filter((call) => call.startsWith("write ")).map((call) => call.slice("write ".length));
    expect(writes.length).toBeGreaterThan(8);
    expect(buildCalls.filter((call) => call.includes(`${join(root, "private")}`))).toEqual([]);
    for (const path of writes) {
      const inside = path === root || path.startsWith(join(root, "public", "assets", "sample-course")) || path.startsWith(join(root, "assets-map"));
      const parent = path === join(root, "public") || path === join(root, "public", "assets");
      expect(inside || parent, path).toBe(true);
    }
  });

  it("does not ask about private/ when the build folder already has one, with files in it", () => {
    const build = join(temporaryFolder(), "build");
    expect(writeAssets(assetCourse({ "a.png": PNG }), build)).toEqual([]);
    calls.length = 0;

    writeAssets(assetCourse({ "b.png": PNG }), build);
    writeAssets(assetCourse({}, undefined, { assets: null }), build);

    expect(calls.filter((call) => call.includes(join(resolve(build), "private")))).toEqual([]);
    expect(readFileSync(join(build, "assets-map", "sample-course.json"), "utf8")).toContain('"files": {}');
  });
});
