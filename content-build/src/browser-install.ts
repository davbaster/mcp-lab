// `npm run install:browser`: downloads chrome-headless-shell (the build that puppeteer pins) into puppeteer's cache, and first
// removes a half-installed folder of that build, which an install that failed in the middle (for example with no `unzip`) leaves
// behind and which puppeteer then refuses to install over.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The arguments of puppeteer's command: only chrome-headless-shell, never full Chrome. */
export const INSTALL_ARGS = ["browsers", "install", "chrome-headless-shell"];

/** The puppeteer cache: `PUPPETEER_CACHE_DIR` when it is set, else `.cache/puppeteer` in the home folder (`%USERPROFILE%` on Windows). */
export function puppeteerCache(env: Record<string, string | undefined>, home: string = homedir()): string {
  const fromEnv = env.PUPPETEER_CACHE_DIR;
  return resolve(fromEnv !== undefined && fromEnv.trim() !== "" ? fromEnv : join(home, ".cache", "puppeteer"));
}

export type Recovery =
  /** The executable is there: nothing was touched. */
  | { status: "complete"; folder: string }
  /** There is no folder of this build: nothing to do. */
  | { status: "none"; folder: string }
  /** The folder existed without its executable, and was removed. */
  | { status: "removed"; folder: string }
  /** The executable is not in this cache (`PUPPETEER_EXECUTABLE_PATH`, or a path that is not of the shape puppeteer uses): nothing was touched. */
  | { status: "outside"; folder: string };

/**
 * Removes the folder of the pinned build (`<cache>/chrome-headless-shell/<platform>-<build>`) when it exists but `executablePath`,
 * the file inside it that puppeteer launches, does not. Only that one folder is removed, and only when it is inside `<cache>/chrome-headless-shell/`.
 * A complete install, another build, another browser, and everything else in the cache stay as they are.
 */
export function recoverBrowserFolder(executablePath: string, cache: string): Recovery {
  const folder = dirname(dirname(resolve(executablePath)));
  const browsers = join(resolve(cache), "chrome-headless-shell");
  const inside = relative(browsers, folder);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside) || inside.includes("/") || inside.includes("\\")) return { status: "outside", folder };
  if (!existsSync(folder)) return { status: "none", folder };
  if (existsSync(executablePath)) return { status: "complete", folder };
  rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  return { status: "removed", folder };
}

/** What to tell the author when the output of a failed install shows that the archive could not be unpacked, else undefined. */
export function unzipHint(output: string): string | undefined {
  if (!/no zip archiver|extraction failed|unzip/i.test(output)) return undefined;
  return "the browser could not be unpacked: install `unzip` (Linux: `sudo apt-get install unzip`; macOS has it; Windows uses tar.exe or PowerShell), then run `npm run install:browser` again. The half-installed folder that this left is removed by that run.";
}

export type RunResult = { status: number | null; output: string };

export type InstallOptions = {
  env?: Record<string, string | undefined>;
  /** The file puppeteer launches for chrome-headless-shell. Defaults to puppeteer's answer. */
  executablePath?: string;
  /** Runs puppeteer's install command and returns its exit status and its output. Defaults to a child process. */
  run?: (args: string[], env: Record<string, string | undefined>) => RunResult;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
};

/** The command line of puppeteer, found from this file (`node_modules/puppeteer`), and run with the Node that runs this. */
function runPuppeteer(args: string[], env: Record<string, string | undefined>): RunResult {
  let folder = dirname(fileURLToPath(import.meta.resolve("puppeteer")));
  while (!existsSync(join(folder, "package.json")) || (JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as { name?: unknown }).name !== "puppeteer") {
    const parent = dirname(folder);
    if (parent === folder) throw new Error("the package puppeteer is not installed; run `npm ci`");
    folder = parent;
  }
  const bin = (JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as { bin?: string }).bin ?? "lib/puppeteer/node/cli.js";
  const result = spawnSync(process.execPath, [join(folder, bin), ...args], { encoding: "utf8", env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
  return { status: result.status, output: `${result.stdout}${result.stderr}${result.error === undefined ? "" : String(result.error)}` };
}

/** Recovers from a half-installed folder, then installs. Returns the exit code. */
export async function installBrowser(options: InstallOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((text) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text) => process.stderr.write(text));
  const run = options.run ?? runPuppeteer;
  const executablePath = options.executablePath ?? (await (await import("puppeteer")).default.executablePath({ headless: "shell" }));

  const recovery = recoverBrowserFolder(executablePath, puppeteerCache(env));
  if (recovery.status === "removed") stdout(`removed the half-installed browser folder ${recovery.folder} (an earlier install did not finish); installing again\n`);

  const result = run(INSTALL_ARGS, env);
  if (result.status === 0) stdout(result.output);
  else stderr(result.output);
  if (result.status !== 0 || !existsSync(executablePath)) {
    const hint = unzipHint(result.output);
    stderr(`${hint ?? `the browser was not installed: ${executablePath} is missing after the install; run the command again, and if it fails again, delete ${recovery.folder}`}\n`);
    return result.status === 0 || result.status === null ? 1 : result.status;
  }
  return 0;
}
