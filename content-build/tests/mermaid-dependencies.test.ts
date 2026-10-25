// What the repo says about the renderer's packages: which parts may have them, that they are pinned, and that `npm ci` downloads no browser.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALL_ARGS } from "../src/browser-install.ts";
import { PART_DIR } from "./helpers.ts";

const ROOT = join(PART_DIR, "..");
const read = (...path: string[]) => readFileSync(join(ROOT, ...path), "utf8");
type PackageJson = { dependencies: Record<string, string>; scripts: Record<string, string>; puppeteer?: unknown };
type PackageLock = { packages: Record<string, { version: string; dependencies: Record<string, string> } | undefined> };
const json = <T>(...path: string[]) => JSON.parse(read(...path)) as T;

describe("only content-build has the renderer", () => {
  it.each([
    ["frontend/package.json", ["frontend", "package.json"]],
    ["frontend/package-lock.json", ["frontend", "package-lock.json"]],
    ["backend/pyproject.toml", ["backend", "pyproject.toml"]],
    ["backend/uv.lock", ["backend", "uv.lock"]],
  ])("%s names neither mermaid nor puppeteer", (_name, path) => {
    expect(read(...path)).not.toMatch(/mermaid|puppeteer/i);
  });

  it("has them in content-build/package.json, as dependencies", () => {
    const { dependencies } = json<PackageJson>("content-build", "package.json");

    expect(Object.keys(dependencies)).toContain("@mermaid-js/mermaid-cli");
    expect(Object.keys(dependencies)).toContain("puppeteer");
  });
});

describe("the pins", () => {
  it("pins @mermaid-js/mermaid-cli to 12.0.0 and puppeteer to 25.16.0, exactly (no ^ or ~)", () => {
    const { dependencies } = json<PackageJson>("content-build", "package.json");

    expect(dependencies["@mermaid-js/mermaid-cli"]).toBe("12.0.0");
    expect(dependencies["puppeteer"]).toBe("25.16.0");
  });

  it("has the same versions in package-lock.json, and the Windows packages of the one native dependency, so `npm ci` works there", () => {
    const { packages } = json<PackageLock>("content-build", "package-lock.json");

    expect(packages["node_modules/@mermaid-js/mermaid-cli"]?.version).toBe("12.0.0");
    expect(packages["node_modules/puppeteer"]?.version).toBe("25.16.0");
    expect(packages["node_modules/@napi-rs/canvas-win32-x64-msvc"]).toBeDefined();
    expect(packages["node_modules/@napi-rs/canvas-win32-arm64-msvc"]).toBeDefined();
    expect(packages[""]?.dependencies["puppeteer"]).toBe("25.16.0");
  });
});

describe("the browser is a separate install", () => {
  it("has .puppeteerrc.cjs with skipDownload: true, so `npm ci` downloads no browser", () => {
    const configuration = createRequire(import.meta.url)(join(PART_DIR, ".puppeteerrc.cjs")) as Record<string, unknown>;

    expect(configuration).toEqual({ skipDownload: true });
  });

  // The backend image copies only package.json and package-lock.json before `npm ci` (backend/Dockerfile), so .puppeteerrc.cjs is
  // not there then. Measured: `npm ci` with only those two files downloaded 676 MB (Chrome and chrome-headless-shell) without this key.
  it("has the same setting in the puppeteer key of package.json, which is all the backend image has when it runs npm ci", () => {
    expect(json<PackageJson>("content-build", "package.json").puppeteer).toEqual({ skipDownload: true });
  });

  it("has an install:browser script that runs src/install-browser.ts, which downloads only chrome-headless-shell (not full Chrome)", () => {
    expect(json<PackageJson>("content-build", "package.json").scripts["install:browser"]).toBe("node src/install-browser.ts");
    expect(INSTALL_ARGS).toEqual(["browsers", "install", "chrome-headless-shell"]);
  });

  it("has make install-content-build run npm ci and then npm run install:browser, as two lines", () => {
    const makefile = read("Makefile");
    const recipe = /^install-content-build:\n((?:\t.*\n)+)/m.exec(makefile)?.[1];

    expect(recipe?.split("\n").filter((line) => line !== "")).toEqual(["\tcd content-build && npm ci", "\tcd content-build && npm run install:browser"]);
  });

  it("keeps the cache folder out of git", () => {
    expect(read(".gitignore").split("\n")).toContain("/content-build/.cache/");
  });
});
