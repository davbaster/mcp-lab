// `npm run install:browser` recovers from a half-installed browser folder and says what to do when unpacking fails. A temporary cache folder
// stands in for puppeteer's; nothing is downloaded.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALL_ARGS, installBrowser, puppeteerCache, recoverBrowserFolder, unzipHint } from "../src/browser-install.ts";
import type { RunResult } from "../src/browser-install.ts";
import { PART_DIR, SLOW_PROCESS_TIMEOUT_MS, temporaryFolder } from "./helpers.ts";

const BUILD = "linux-156.0.8078.47";
const EXE_NAME = "chrome-headless-shell";

/** A cache folder with the shape puppeteer uses, and the path of the executable of `BUILD` in it (not created). */
function cache() {
  const root = temporaryFolder();
  const folder = join(root, "chrome-headless-shell", BUILD);
  return { root, folder, exe: join(folder, "chrome-headless-shell-linux64", EXE_NAME) };
}

const makeFile = (path: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
};

describe("which cache folder", () => {
  it("is PUPPETEER_CACHE_DIR when it is set, and .cache/puppeteer in the home folder otherwise", () => {
    expect(puppeteerCache({ PUPPETEER_CACHE_DIR: "/somewhere/else" }, "/home/u")).toBe(resolve("/somewhere/else"));
    expect(puppeteerCache({}, "/home/u")).toBe(resolve("/home/u", ".cache", "puppeteer"));
    expect(puppeteerCache({ PUPPETEER_CACHE_DIR: "  " }, "/home/u")).toBe(resolve("/home/u", ".cache", "puppeteer"));
  });
});

describe("recoverBrowserFolder", () => {
  it("removes the folder of the build when it exists without its executable, and nothing else in the cache", () => {
    const { root, folder, exe } = cache();
    makeFile(join(folder, "chrome-headless-shell-linux64", "partial.bin"));
    makeFile(join(root, "chrome-headless-shell", "linux-155.0.0.1", "chrome-headless-shell-linux64", EXE_NAME));
    makeFile(join(root, "chrome", "linux-156.0.8078.47", "chrome-linux64", "chrome"));
    makeFile(join(root, "notes.txt"));

    const result = recoverBrowserFolder(exe, root);

    expect(result).toEqual({ status: "removed", folder });
    expect(existsSync(folder)).toBe(false);
    expect(readdirSync(join(root, "chrome-headless-shell"))).toEqual(["linux-155.0.0.1"]);
    expect(existsSync(join(root, "chrome", "linux-156.0.8078.47", "chrome-linux64", "chrome"))).toBe(true);
    expect(existsSync(join(root, "notes.txt"))).toBe(true);
  });

  it("removes a folder that is empty too", () => {
    const { root, folder, exe } = cache();
    mkdirSync(folder, { recursive: true });

    expect(recoverBrowserFolder(exe, root).status).toBe("removed");
    expect(existsSync(folder)).toBe(false);
  });

  it("leaves a complete install alone", () => {
    const { root, folder, exe } = cache();
    makeFile(exe);
    makeFile(join(folder, "chrome-headless-shell-linux64", "other.bin"));

    expect(recoverBrowserFolder(exe, root)).toEqual({ status: "complete", folder });
    expect(existsSync(exe)).toBe(true);
    expect(existsSync(join(folder, "chrome-headless-shell-linux64", "other.bin"))).toBe(true);
  });

  it("does nothing when there is no folder of the build, and creates nothing", () => {
    const { root, exe } = cache();

    expect(recoverBrowserFolder(exe, root).status).toBe("none");
    expect(readdirSync(root)).toEqual([]);
  });

  it("removes nothing when the executable is not inside <cache>/chrome-headless-shell/<build>/ (an executable path set by hand, a path with ..)", () => {
    const { root } = cache();
    const elsewhere = temporaryFolder();
    makeFile(join(elsewhere, "keep.txt"));
    const outside = join(elsewhere, "shell", "bin", EXE_NAME);
    const traversal = join(root, "chrome-headless-shell", BUILD, "..", "..", "..", "x", "bin", EXE_NAME);
    mkdirSync(join(elsewhere, "shell"), { recursive: true });

    expect(recoverBrowserFolder(outside, root).status).toBe("outside");
    expect(recoverBrowserFolder(traversal, root).status).toBe("outside");
    expect(recoverBrowserFolder(join(root, "chrome-headless-shell", EXE_NAME), root).status).toBe("outside");
    expect(existsSync(join(elsewhere, "keep.txt"))).toBe(true);
    expect(existsSync(join(elsewhere, "shell"))).toBe(true);
  });
});

describe("unzipHint", () => {
  it("tells the author to install unzip when the output says the extraction failed for want of an archiver", () => {
    const message = "Error: Extraction failed: no zip archiver is available. Install `unzip` (or `tar.exe`/Powershell on Windows)";

    expect(unzipHint(message)).toMatch(/install `unzip`.*npm run install:browser/);
    expect(unzipHint("spawn unzip ENOENT")).toBeDefined();
  });

  it("says nothing for another failure", () => {
    expect(unzipHint("getaddrinfo ENOTFOUND storage.googleapis.com")).toBeUndefined();
  });
});

describe("installBrowser", () => {
  function setup(options: { half?: boolean; run: (args: string[], folderExistedWhenRun: boolean) => RunResult | ((exe: string) => RunResult) }) {
    const { root, folder, exe } = cache();
    if (options.half) makeFile(join(folder, "chrome-headless-shell-linux64", "partial.bin"));
    let out = "";
    let err = "";
    const calls: { args: string[]; folderExisted: boolean }[] = [];
    const run = (args: string[]) => {
      calls.push({ args, folderExisted: existsSync(folder) });
      const result = options.run(args, existsSync(folder));
      return typeof result === "function" ? result(exe) : result;
    };
    const go = () => installBrowser({ env: { PUPPETEER_CACHE_DIR: root }, executablePath: exe, run, stdout: (t) => (out += t), stderr: (t) => (err += t) });
    return { root, folder, exe, calls, go, out: () => out, err: () => err };
  }

  it("removes a half-installed folder first, then runs the install of chrome-headless-shell only, and succeeds when the executable is there", async () => {
    const test = setup({
      half: true,
      run: () => (exe) => {
        makeFile(exe);
        return { status: 0, output: "chrome-headless-shell@156 installed\n" };
      },
    });

    const code = await test.go();

    expect(code).toBe(0);
    expect(test.calls).toEqual([{ args: INSTALL_ARGS, folderExisted: false }]);
    expect(INSTALL_ARGS).toEqual(["browsers", "install", "chrome-headless-shell"]);
    expect(test.out()).toContain(`removed the half-installed browser folder ${test.folder}`);
    expect(test.out()).toContain("installed");
    expect(test.err()).toBe("");
  });

  it("does not remove anything, and still runs the install, when the install is complete", async () => {
    const test = setup({ run: () => ({ status: 0, output: "already installed\n" }) });
    makeFile(test.exe);

    const code = await test.go();

    expect(code).toBe(0);
    expect(existsSync(test.exe)).toBe(true);
    expect(test.out()).not.toContain("removed");
  });

  it("says to install unzip, and exits non-zero, when the extraction failed for want of unzip", async () => {
    const test = setup({
      run: () => ({ status: 1, output: "Error: Extraction failed: no zip archiver is available. Install `unzip` (or `tar.exe`/Powershell on Windows)\n" }),
    });

    const code = await test.go();

    expect(code).toBe(1);
    expect(test.err()).toContain("Extraction failed");
    expect(test.err()).toMatch(/install `unzip`.*run `npm run install:browser` again/);
  });

  it("fails with a plain message when the install says it worked but the executable is missing", async () => {
    const test = setup({ run: () => ({ status: 0, output: "" }) });

    const code = await test.go();

    expect(code).toBe(1);
    expect(test.err()).toContain(`${test.exe} is missing after the install`);
  });

  it("passes the failure status of puppeteer on, with its output on stderr and no unzip hint for another cause", async () => {
    const test = setup({ run: () => ({ status: 3, output: "getaddrinfo ENOTFOUND storage.googleapis.com\n" }) });

    const code = await test.go();

    expect(code).toBe(3);
    expect(test.err()).toContain("ENOTFOUND");
    expect(test.err()).not.toContain("unzip");
  });
});

describe("npm run install:browser", () => {
  it("is this script (node src/install-browser.ts), and finds a complete install in a temporary cache without downloading anything or touching it", () => {
    const { root } = cache();
    const probe = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", 'import p from "puppeteer"; process.stdout.write(await p.executablePath({ headless: "shell" }));'],
      { cwd: PART_DIR, encoding: "utf8", env: { ...process.env, PUPPETEER_CACHE_DIR: root, PUPPETEER_EXECUTABLE_PATH: "" } },
    );
    expect(probe.status).toBe(0);
    const exe = probe.stdout;
    expect(exe.startsWith(join(root, "chrome-headless-shell"))).toBe(true);
    makeFile(exe);

    const result = spawnSync(process.execPath, [join(PART_DIR, "src", "install-browser.ts")], {
      cwd: temporaryFolder(),
      encoding: "utf8",
      env: { ...process.env, PUPPETEER_CACHE_DIR: root, PUPPETEER_EXECUTABLE_PATH: "" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(exe);
    expect(existsSync(exe)).toBe(true);
  }, SLOW_PROCESS_TIMEOUT_MS);
});
