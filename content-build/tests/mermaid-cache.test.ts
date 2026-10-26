// The cache key and the cache folder.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { POSTPROCESS_VERSION } from "../src/diagram-svg.ts";
import { DEFAULT_CACHE_DIR, SvgCache, cacheDirectory, cacheKey } from "../src/mermaid-cache.ts";
import type { CacheKeyParts } from "../src/mermaid-cache.ts";
import { PART_DIR, temporaryFolder } from "./helpers.ts";
import { fakeSvg } from "./mermaid-helpers.ts";

const PARTS: CacheKeyParts = {
  source: "graph TD\n A --> B",
  config: new TextEncoder().encode('{"theme":"base"}'),
  mermaid: "12.2.0",
  mermaidCli: "12.0.0",
  chromium: "156.0.8078.47",
  postprocess: 1,
};

describe("the key", () => {
  it("is 64 hex digits", () => {
    expect(cacheKey(PARTS)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is the same for the same input and counts CRLF as LF", () => {
    expect(cacheKey({ ...PARTS })).toBe(cacheKey(PARTS));
    expect(cacheKey({ ...PARTS, source: PARTS.source.replaceAll("\n", "\r\n") })).toBe(cacheKey(PARTS));
  });

  it.each<[string, Partial<CacheKeyParts>]>([
    ["the source", { source: "graph TD\n A --> C" }],
    ["one space in the source", { source: "graph TD\n A  --> B" }],
    ["the bytes of mermaid-config.json", { config: new TextEncoder().encode('{"theme":"base" }') }],
    ["the version of mermaid", { mermaid: "12.2.1" }],
    ["the version of mermaid-cli", { mermaidCli: "12.0.1" }],
    ["the build of Chromium", { chromium: "156.0.8078.48" }],
    ["the version of the post-processing", { postprocess: 2 }],
  ])("is another key when %s changes", (_name, change) => {
    expect(cacheKey({ ...PARTS, ...change })).not.toBe(cacheKey(PARTS));
  });

  it("does not mix up a value that moves from one part to the next", () => {
    expect(cacheKey({ ...PARTS, mermaid: "12.2", mermaidCli: ".0" })).not.toBe(cacheKey({ ...PARTS, mermaid: "12.2.", mermaidCli: "0" }));
  });

  it("uses the version of the post-processing in code when none is given", () => {
    const without = { ...PARTS };
    delete without.postprocess;

    expect(cacheKey(without)).toBe(cacheKey({ ...PARTS, postprocess: POSTPROCESS_VERSION }));
  });
});

describe("the cache folder", () => {
  it("is content-build/.cache/mermaid/ by default, found from the code and not from the working folder, and MERMAID_CACHE_DIR overrides it", () => {
    expect(DEFAULT_CACHE_DIR).toBe(join(PART_DIR, ".cache", "mermaid"));
    expect(cacheDirectory({})).toBe(DEFAULT_CACHE_DIR);
    expect(cacheDirectory({ MERMAID_CACHE_DIR: "  " })).toBe(DEFAULT_CACHE_DIR);
    expect(cacheDirectory({ MERMAID_CACHE_DIR: join(PART_DIR, "x") })).toBe(join(PART_DIR, "x"));
    expect(cacheDirectory({ MERMAID_CACHE_DIR: "elsewhere" }, join(PART_DIR, "y"))).toBe(join(PART_DIR, "y"));
  });
});

describe("an entry", () => {
  const key = cacheKey(PARTS);
  const svg = fakeSvg("x");

  function cache() {
    const directory = join(temporaryFolder(), "cache", "mermaid");
    return { directory, cache: new SvgCache(directory) };
  }

  it("is written as <key>.svg, with no other file left, and read back", () => {
    const { directory, cache: store } = cache();

    store.write(key, svg);

    expect(readdirSync(directory)).toEqual([`${key}.svg`]);
    expect(store.read(key)).toBe(svg);
  });

  it("is missing when there is no file", () => {
    expect(cache().cache.read(key)).toBeUndefined();
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["not UTF-8", Buffer.from([0x3c, 0x73, 0x76, 0x67, 0xff, 0xfe, 0x3e])],
    ["not an SVG", Buffer.from("<html></html>")],
    ["an SVG that the rules reject", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ["an SVG with a link outside the file", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.com"/></svg>')],
    ["an SVG with a byte order mark", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(svg)])],
  ])("is ignored when it is %s", (_name, bytes) => {
    const { directory, cache: store } = cache();
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${key}.svg`), bytes);

    expect(store.read(key)).toBeUndefined();
  });

  it.each(["../escape", "abc", `${key}/..`, `${key.slice(0, 63)}G`, "", `${key}.svg`])("never builds a file name from %j, which is not 64 hex digits", (bad) => {
    const { directory, cache: store } = cache();

    expect(() => store.fileFor(bad)).toThrow(/64 hex digits/);
    expect(() => store.read(bad)).toThrow();
    expect(() => store.write(bad, svg)).toThrow();
    expect(existsSync(directory)).toBe(false);
  });

  it("does not fail the build when the folder cannot be written", () => {
    const { directory, cache: store } = cache();
    mkdirSync(join(directory, ".."), { recursive: true });
    writeFileSync(directory, "a file where the folder should be");

    expect(() => store.write(key, svg)).not.toThrow();
    expect(readFileSync(directory, "utf8")).toBe("a file where the folder should be");
  });
});
