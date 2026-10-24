// A Windows checkout must not change the line endings of any file that a test reads byte for byte or line by line.
// The root .gitattributes says so with one rule per extension; this test asks git (`git check-attr`) about every
// fixture file and every doc the tests read, so a new file with an unclassified extension fails here, not on Windows.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES, PART_DIR, temporaryFolder } from "./helpers.ts";

const ROOT = join(PART_DIR, "..");
const ATTRIBUTES = readFileSync(join(ROOT, ".gitattributes"), "utf8");
/** The docs (outside fixtures/) that the tests read as text. */
const DOCS = ["content-build/README.md", "courses/README.md", "README.md", "AGENTS.md"];

/** Every file under fixtures/, as a path from the repository root with `/`. */
function fixtureFiles(): string[] {
  return readdirSync(FIXTURES, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort();
}

/** The `text` and `eol` attributes that `git check-attr` gives each path, with a throwaway repository that holds only a copy of the rules. */
function resolve(attributes: string, paths: string[]): Map<string, Record<string, string>> {
  const repo = temporaryFolder();
  writeFileSync(join(repo, ".gitattributes"), attributes);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(repo, "no-such-config"), GIT_CONFIG_NOSYSTEM: "1" };
  const git = (args: string[], input?: string) => execFileSync("git", args, { cwd: repo, env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  git(["init", "--quiet"]);

  const found = new Map<string, Record<string, string>>();
  const fields = git(["check-attr", "-z", "--stdin", "text", "eol"], paths.join("\0")).split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [path, name, value] = [fields[i] as string, fields[i + 1] as string, fields[i + 2] as string];
    found.set(path, { ...found.get(path), [name]: value });
  }
  return found;
}

/**
 * The paths that `attributes` (the text of a .gitattributes file) leaves unclassified. Each path must resolve to
 * `text` with `eol=lf`, or to `-text` (which is what `binary` sets, and what the golden output has). The paths
 * need not exist: git matches the names.
 */
function unclassified(attributes: string, paths: string[]): string[] {
  const found = resolve(attributes, paths);
  return paths.filter((path) => {
    const { text, eol } = found.get(path) ?? {};
    return !((text === "set" && eol === "lf") || text === "unset");
  });
}

describe(".gitattributes covers the files that the tests read", () => {
  it("classifies every file under content-build/fixtures/ as LF text or as binary", () => {
    const files = fixtureFiles();

    expect(files.length).toBeGreaterThan(100);
    expect(unclassified(ATTRIBUTES, files)).toEqual([]);
  });

  it.each(DOCS)("keeps %s at LF", (doc) => {
    expect(unclassified(ATTRIBUTES, [doc])).toEqual([]);
  });

  it("keeps the golden public output as it is, with no conversion", () => {
    const golden = fixtureFiles().filter((path) => path.startsWith("content-build/fixtures/expected/public/"));

    expect(golden.length).toBeGreaterThan(0);
    expect(unclassified(ATTRIBUTES, golden)).toEqual([]);
    const converted = golden.filter((path) => /\.(svg|gltf|vtt)$/.test(path));
    expect(converted.length).toBeGreaterThan(0);
    // The `-text` rule comes last, so the new LF rules never reach these files.
    expect([...resolve(ATTRIBUTES, converted).values()].map((found) => found.text)).toEqual(converted.map(() => "unset"));
  });

  it("fails for a fixture with an extension that has no rule", () => {
    expect(unclassified(ATTRIBUTES, ["content-build/fixtures/valid/sample-course/assets/new.xyz", "content-build/fixtures/valid/sample-course/notes.toml"])).toEqual([
      "content-build/fixtures/valid/sample-course/assets/new.xyz",
      "content-build/fixtures/valid/sample-course/notes.toml",
    ]);
  });

  it("fails for a doc that has no rule", () => {
    expect(unclassified(ATTRIBUTES, ["content-build/NOTES.md", "docs/guide.md"])).toEqual(["content-build/NOTES.md", "docs/guide.md"]);
  });

  it("fails for a fixture file when its rule is removed", () => {
    // yaml, json, and svg are also covered by older rules that name a folder, so only the others are checked here.
    for (const extension of ["mdx", "md", "py", "gltf", "vtt", "txt"]) {
      const without = ATTRIBUTES.split("\n")
        .filter((line) => !line.startsWith(`content-build/fixtures/**/*.${extension} `))
        .join("\n");
      const left = unclassified(without, fixtureFiles()).filter((path) => path.endsWith(`.${extension}`));
      expect(left.length, extension).toBeGreaterThan(0);
    }
  });

  it("fails for a binary fixture when its rule is removed, so it would be converted", () => {
    const without = ATTRIBUTES.split("\n")
      .filter((line) => !/^content-build\/fixtures\/\*\*\/\*\.(jpeg|mp4|webm) /.test(line))
      .join("\n");

    expect(unclassified(without, fixtureFiles()).map((path) => path.split(".").pop()).sort()).toEqual(["jpeg", "mp4", "webm"]);
  });

  it("fails for the doc READMEs when their rules are removed", () => {
    const without = ATTRIBUTES.split("\n")
      .filter((line) => !/^(content-build\/|courses\/)README\.md /.test(line))
      .join("\n");

    expect(unclassified(without, DOCS)).toEqual(["content-build/README.md", "courses/README.md"]);
  });
});
