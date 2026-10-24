// The notes about assets in the READMEs stay true.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMediaConfig } from "../src/media-config.ts";
import { ASSET_TYPES, REFERENCE_PROPS } from "../src/assets.ts";
import { PART_DIR } from "./helpers.ts";

const COURSES_README = readFileSync(join(PART_DIR, "..", "courses", "README.md"), "utf8");
const README = readFileSync(join(PART_DIR, "README.md"), "utf8");
const section = /^## Assets$([\s\S]*?)^## Layout$/m.exec(README)?.[1] ?? "";

describe("content-build/README.md, Assets", () => {
  it("has an Assets section with its parts", () => {
    expect(section.length).toBeGreaterThan(2000);
    for (const heading of ["### Files in `assets/`", "### SVG rules", "### The media config", "### References in lessons", "### Writing the assets", "### Pointing a lesson at the hashed files"]) {
      expect(section, heading).toContain(heading);
    }
  });

  it("names every allowed type, every limit, and every key of the media config", () => {
    for (const type of ASSET_TYPES) expect(section, type).toContain(`\`.${type}\``);
    for (const key of ["mediaOrigins", "embeds", "origin", "pathPrefix", "idPattern", "watchHosts", "assetLimits", "imageBytes", "modelBytes", "captionBytes"]) {
      expect(section, key).toContain(`\`${key}\``);
    }
    expect(section).toContain("5 MiB");
    expect(section).toContain("25 MiB");
    expect(section).toContain("1 MiB");
  });

  it("says that the Content-Security-Policy of #20 is generated from the config, which it reads and does not copy", () => {
    expect(section).toMatch(/#20.*generated from this file.*reads and does not copy/);
    expect(section).toContain("`img-src` and `media-src`");
    expect(section).toContain("`frame-src`");
  });

  it("says that the SVG checks are one layer, with the <img> of #19 and the headers of #58", () => {
    expect(section).toContain("These checks are one layer");
    expect(section).toContain("`<img>` (#19)");
    expect(section).toContain("`script-src 'none'` and `nosniff` (#58)");
  });

  it("describes the output layout, the map, and rewriteAssetUrls, and says that #12 writes the lesson trees", () => {
    for (const text of [
      "<buildDir>/public/assets/<course_id>/",
      "<buildDir>/assets-map/<course_id>.json",
      "<stem>-<first 16 hex digits of the SHA-256>.<ext>",
      "rewriteAssetUrls(tree, courseId, assetMap)",
      "/api/courses/<course_id>/assets/<hashed file name>",
      "#12",
    ]) {
      expect(section, text).toContain(text);
    }
  });

  it("lists every prop of the table as a reference", () => {
    for (const [component, props] of Object.entries(REFERENCE_PROPS)) {
      for (const prop of Object.keys(props)) expect(section, `${component}.${prop}`).toContain(`\`${component}.${prop}\``);
    }
  });

  it("shows a config example that matches the committed file", () => {
    const example = JSON.parse(/```json\n(\{\n {2}"mediaOrigins"[\s\S]*?\n\})\n```/.exec(section)?.[1] ?? "null");
    const committed = loadMediaConfig();

    expect(example.mediaOrigins).toEqual(committed.mediaOrigins);
    expect(example.embeds[0]).toEqual(committed.embeds[0]);
    expect(example.assetLimits).toEqual(committed.assetLimits);
  });
});

describe("courses/README.md", () => {
  it("links the assets line to the section and no longer says it is checked in #9", () => {
    expect(COURSES_README).not.toContain("(checked in #9)");
    expect(COURSES_README).toContain("](../content-build/README.md#assets)");
  });
});
