// buildChapterZip on files in memory: the bytes depend on the chapter name and the files, not on the order they come in.

import { describe, expect, it } from "vitest";
import { buildChapterZip } from "../src/chapter-zip.ts";

const files = (entries: [string, string][]) => new Map(entries);

describe("buildChapterZip", () => {
  it("gives the same bytes whatever the order of the files", async () => {
    const a = await buildChapterZip("03-tools", files([["b.py", "2\n"], ["a/z.py", "1\n"], ["B.py", "3\n"]]));
    const b = await buildChapterZip("03-tools", files([["B.py", "3\n"], ["a/z.py", "1\n"], ["b.py", "2\n"]]));

    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(a.file).toBe(b.file);
  });

  it("names the file after the chapter and the first 16 hex digits of the hash", async () => {
    const zip = await buildChapterZip("03-tools", files([["main.py", "x\n"]]));

    expect(zip.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(zip.file).toBe(`03-tools-${zip.sha256.slice(0, 16)}.zip`);
  });

  it("changes the name when a file's text changes, and when the chapter's name changes", async () => {
    const base = await buildChapterZip("03-tools", files([["main.py", "x\n"]]));

    expect((await buildChapterZip("03-tools", files([["main.py", "y\n"]]))).file).not.toBe(base.file);
    expect((await buildChapterZip("04-tools", files([["main.py", "x\n"]]))).sha256).not.toBe(base.sha256);
  });
});
