// Draws Mermaid text to SVG in a Chromium that the build starts. Only `npm run build` gets here, and only for a diagram
// that is not in the cache.
//
// The browser is `chrome-headless-shell` (the build that puppeteer pins; `make install-content-build` downloads it), with no
// network, a temporary profile, and its sandbox on (see `launchArguments`). The page holds only Mermaid and the text of the
// diagram, from this repo. puppeteer and mermaid-cli are imported when the first diagram is drawn, so the other commands never load them.

import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Browser, LaunchOptions } from "puppeteer";
import { SetupError } from "./component-schemas.ts";
import { SVG_ID } from "./diagram-svg.ts";
import type { MermaidConfig } from "./mermaid-config.ts";

/** How long one diagram may take to draw. */
export const RENDER_TIMEOUT_MS = 30_000;

/** The size of the page. Fixed, so the same on every machine (the diagrams do not use it: `useMaxWidth` is false). */
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };

/** What a renderer knows: it draws one source to the text of an SVG, or throws a `DiagramRenderError`. */
export type DiagramRenderer = {
  render(source: string): Promise<string>;
  close(): Promise<void>;
};

/** Starts a renderer. `build` calls it once, and only when a diagram is not in the cache. It throws a `SetupError` when the browser is not installed. */
export type RendererFactory = (config: MermaidConfig) => Promise<DiagramRenderer>;

export type RenderErrorKind = "mermaid" | "timeout" | "crash";

/** A diagram that could not be drawn. For `mermaid` the message is Mermaid's own text (no stack, no path, no URL); the other kinds say what happened. */
export class DiagramRenderError extends Error {
  override name = "DiagramRenderError";
  readonly kind: RenderErrorKind;
  constructor(kind: RenderErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export type RendererOptions = {
  /** Starts the browser. Defaults to puppeteer's `launch`, with the installed `chrome-headless-shell`. For tests. */
  launch?: (options: LaunchOptions) => Promise<Browser>;
  /** The environment, for `MERMAID_NO_SANDBOX`. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Whether the build runs as root. Defaults to the real user (never true on Windows). For tests. */
  isRoot?: boolean;
  /** The time one diagram may take. Defaults to {@link RENDER_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Removes the temporary profile folder. Defaults to `rmSync` with `recursive`. For tests (Windows can refuse for a while after the browser exits). */
  remove?: (folder: string) => void;
  /** How often removing the profile is tried, and how long to wait between tries. Defaults to {@link PROFILE_REMOVE_TRIES} and {@link PROFILE_REMOVE_DELAY_MS}. */
  removeTries?: number;
  removeDelayMs?: number;
  /** Where the warning goes when the profile cannot be removed. Defaults to stderr. */
  warn?: (text: string) => void;
};

/** Windows keeps the files of a browser locked for a short time after it exits, so removing its profile is tried again and again before it is given up. */
export const PROFILE_REMOVE_TRIES = 20;
export const PROFILE_REMOVE_DELAY_MS = 250;

/**
 * The flags of the browser: no network (every host name, and so every address, is not found), and `--no-sandbox` only when the
 * build runs as root or `MERMAID_NO_SANDBOX=1` (Ubuntu 24.04 can block the sandbox for a normal user). That is acceptable because
 * the page holds only Mermaid and lesson text from this repo, offline. Never `--disable-web-security`.
 */
export function launchArguments(env: Record<string, string | undefined>, isRoot: boolean): string[] {
  const args = ["--host-resolver-rules=MAP * ~NOTFOUND", "--font-render-hinting=none"];
  if (isRoot || env.MERMAID_NO_SANDBOX === "1") args.push("--no-sandbox");
  return args;
}

/** True when the build runs as root (not on Windows, which has no user ID). */
function runsAsRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

class Timeout extends Error {}

/** Resolves with `promise`, or rejects with a `Timeout` after `ms`. The late result of `promise` is ignored. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  promise.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Timeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

// A line of a stack trace: `at ...`, or `name (url:line:column)`, or `name (<anonymous>)`.
const STACK_FRAME = /^\s*at\s|\((?:https?|file|blob|data):[^)]*\)\s*$|\(<anonymous>\)\s*$/;
const URL_IN_TEXT = /(?:https?|file|blob):[^\s)'"`]*/g;
const PATH_IN_TEXT = /[A-Za-z]:[\\/][^\s)'"`]*|(?<![\w:.~-])\/(?:[\w.~-]+\/)+[\w.~-]*/g;

/**
 * Mermaid's message as the author should see it: its own text up to the stack trace, with no stack frames, no absolute path, and
 * no URL (a path or a URL in the text becomes `<path>` or `<url>`), and no trailing white space.
 */
export function mermaidMessage(raw: string): string {
  const lines: string[] = [];
  for (const line of raw.replace(/\r\n?/g, "\n").split("\n")) {
    if (STACK_FRAME.test(line)) break;
    lines.push(line.replace(/\s+$/, ""));
  }
  const text = lines.join("\n").trim().replace(URL_IN_TEXT, "<url>").replace(PATH_IN_TEXT, "<path>");
  return text === "" ? "Mermaid gave no reason" : text;
}

/** The text of the error that Mermaid draws instead of a diagram for some syntax errors (the lines after "Syntax error in text" and the version). */
export function errorTextOfSvg(svg: string): string | undefined {
  const root = /^<svg\b[^>]*>/.exec(svg)?.[0] ?? "";
  if (!/\saria-roledescription="error"/.test(root)) return undefined;
  const lines = [...svg.matchAll(/<text\b[^>]*\bclass="error-text"[^>]*>([^<]*)<\/text>/g)].map((match) => (match[1] ?? "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
  return lines.slice(2).join(" ");
}

const CRASH = /target closed|session closed|connection closed|protocol error|browser has disconnected|browser process|crash/i;

/**
 * Starts a browser and returns the renderer that draws with it. One browser draws every diagram of the build. If the browser
 * crashes or a diagram runs out of time, that browser is thrown away and the next diagram gets a new one.
 */
export async function createMermaidRenderer(config: MermaidConfig, options: RendererOptions = {}): Promise<DiagramRenderer> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? RENDER_TIMEOUT_MS;
  const args = launchArguments(env, options.isRoot ?? runsAsRoot());
  const { launch, executablePath } = options.launch === undefined ? await installedBrowser() : { launch: options.launch, executablePath: undefined };
  const { renderMermaid } = await import("@mermaid-js/mermaid-cli");

  let browser: Browser | undefined;
  let profile: string | undefined;

  const start = async () => {
    profile = mkdtempSync(join(tmpdir(), "mermaid-profile-"));
    const launchOptions: LaunchOptions = { headless: "shell", args, userDataDir: profile, defaultViewport: VIEWPORT };
    if (executablePath !== undefined) launchOptions.executablePath = executablePath;
    browser = await launch(launchOptions);
  };

  const remove = options.remove ?? ((folder: string) => rmSync(folder, { recursive: true, force: true }));
  const warn = options.warn ?? ((text: string) => void process.stderr.write(text));

  /** Waits until `child` has exited (or `ms` have passed), so that it no longer holds the files of the profile. */
  const exited = (child: ChildProcess | null | undefined, ms: number) =>
    child === null || child === undefined || child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });

  /** Removes the profile folder, trying again while the system refuses. A folder that cannot be removed is a warning, never an error of the build. */
  const removeProfile = async (folder: string) => {
    const tries = options.removeTries ?? PROFILE_REMOVE_TRIES;
    let failure: unknown;
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      try {
        remove(folder);
        return;
      } catch (error) {
        failure = error;
        if (attempt < tries) await new Promise((resolve) => setTimeout(resolve, options.removeDelayMs ?? PROFILE_REMOVE_DELAY_MS));
      }
    }
    warn(`warning: the temporary browser profile ${folder} could not be removed (${failure instanceof Error ? failure.message : String(failure)}); delete it by hand\n`);
  };

  const discard = async () => {
    const old = browser;
    browser = undefined;
    if (old !== undefined) {
      const child = old.process();
      await Promise.race([old.close().catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, 5000).unref())]);
      try {
        if (child !== null && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      } catch {
        // already gone
      }
      // The browser must be gone before its profile is removed: a running browser holds files in it (Windows refuses with EPERM).
      await exited(child, 5000);
    }
    if (profile !== undefined) await removeProfile(profile);
    profile = undefined;
  };

  await start();

  return {
    async render(source: string): Promise<string> {
      if (browser === undefined) await start();
      const current = browser as Browser;
      // renderMermaid prints what the page logs (for a blocked address, "Failed to load resource"); a failure is reported once, as an error of the diagram.
      const warn = console.warn;
      console.warn = () => undefined;
      try {
        const result = await withTimeout(
          renderMermaid(current, source, "svg", {
            backgroundColor: "transparent",
            mermaidConfig: config.settings as NonNullable<Parameters<typeof renderMermaid>[3]>["mermaidConfig"],
            svgId: SVG_ID,
            fontEmbed: false,
            viewport: VIEWPORT,
          }),
          timeoutMs,
        );
        const svg = new TextDecoder().decode(result.data);
        const syntax = errorTextOfSvg(svg);
        if (syntax !== undefined) throw new DiagramRenderError("mermaid", mermaidMessage(syntax));
        return svg;
      } catch (error) {
        if (error instanceof DiagramRenderError) throw error;
        if (error instanceof Timeout) {
          await discard();
          throw new DiagramRenderError("timeout", `drawing this diagram took longer than ${timeoutMs / 1000} seconds, so it was stopped; make the diagram smaller`);
        }
        const message = error instanceof Error ? error.message : String(error);
        if (!current.connected || CRASH.test(message)) {
          await discard();
          throw new DiagramRenderError("crash", "the browser crashed while it drew this diagram; run the build again");
        }
        throw new DiagramRenderError("mermaid", mermaidMessage(message));
      } finally {
        console.warn = warn;
      }
    },
    async close() {
      await discard();
    },
  };
}

/** The build of the browser that puppeteer pins, as it is named in the cache folder and in the cache key. */
export async function chromiumBuild(): Promise<string> {
  // puppeteer exports the revisions it pins, but its type declarations do not list them.
  const { PUPPETEER_REVISIONS } = (await import("puppeteer")) as unknown as { PUPPETEER_REVISIONS: Record<string, string> };
  const build = PUPPETEER_REVISIONS["chrome-headless-shell"];
  if (build === undefined) throw new SetupError("puppeteer does not pin a chrome-headless-shell build");
  return build;
}

/**
 * puppeteer's `launch` with the installed `chrome-headless-shell` of the pinned build. A browser that is not installed, or a
 * `PUPPETEER_EXECUTABLE_PATH` that points somewhere else, is a `SetupError`: the same bytes need the same browser.
 */
async function installedBrowser(): Promise<{ launch: (options: LaunchOptions) => Promise<Browser>; executablePath: string }> {
  const puppeteer = (await import("puppeteer")).default;
  const build = await chromiumBuild();
  const executablePath = await puppeteer.executablePath({ headless: "shell" });
  const folder = dirname(dirname(dirname(executablePath)));
  if (!executablePath.includes("chrome-headless-shell") || !executablePath.includes(build)) {
    throw new SetupError(
      `the build needs chrome-headless-shell ${build}, but puppeteer would start ${executablePath} (is PUPPETEER_EXECUTABLE_PATH set?); unset it and run \`make install-content-build\``,
    );
  }
  if (!existsSync(executablePath)) {
    throw new SetupError(
      `Chromium (chrome-headless-shell ${build}) is not installed: it is not in ${folder}; run \`make install-content-build\` to download it (set PUPPETEER_CACHE_DIR to keep it somewhere else)`,
    );
  }
  return { launch: (launchOptions) => puppeteer.launch(launchOptions), executablePath };
}
