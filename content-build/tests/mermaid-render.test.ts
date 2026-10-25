// The renderer without a real browser (tier 1): how the browser is started, what its failures become, and what Mermaid's message is cleaned to.

import { existsSync } from "node:fs";
import type { Browser, LaunchOptions } from "puppeteer";
import { describe, expect, it } from "vitest";
import { DiagramRenderError, RENDER_TIMEOUT_MS, createMermaidRenderer, errorTextOfSvg, launchArguments, mermaidMessage } from "../src/mermaid-render.ts";
import { loadMermaidConfig } from "../src/mermaid-config.ts";

type FakeBrowser = Omit<Browser, "connected"> & { connected: boolean; closed: boolean };

/** A browser that is not one: `newPage` is what the renderer's first step calls, and `behave` decides what it does. */
function fakeLauncher(behave: (browser: FakeBrowser) => Promise<never> = () => new Promise<never>(() => undefined)) {
  const launches: { options: LaunchOptions; profileExisted: boolean }[] = [];
  const browsers: FakeBrowser[] = [];
  const launch = async (options: LaunchOptions): Promise<Browser> => {
    launches.push({ options, profileExisted: options.userDataDir !== undefined && existsSync(options.userDataDir) });
    const browser = {
      connected: true,
      closed: false,
      newPage: () => behave(browser),
      close: async () => {
        browser.closed = true;
        browser.connected = false;
      },
      process: () => null,
    } as unknown as FakeBrowser;
    browsers.push(browser);
    return browser as unknown as Browser;
  };
  return { launch, launches, browsers };
}

const CONFIG = loadMermaidConfig();

describe("how the browser is started", () => {
  it("starts chrome-headless-shell with no network, a temporary profile, and no --disable-web-security", async () => {
    const fake = fakeLauncher();

    const renderer = await createMermaidRenderer(CONFIG, { launch: fake.launch, env: {}, isRoot: false });
    await renderer.close();

    expect(fake.launches).toHaveLength(1);
    const { options, profileExisted } = fake.launches[0] ?? { options: {}, profileExisted: false };
    expect(options.headless).toBe("shell");
    expect(options.args).toContain("--host-resolver-rules=MAP * ~NOTFOUND");
    expect(options.args?.some((arg) => arg.includes("disable-web-security"))).toBe(false);
    expect(options.userDataDir).toMatch(/mermaid-profile-/);
    expect(profileExisted).toBe(true);
  });

  it("keeps the sandbox on for a normal user", async () => {
    const fake = fakeLauncher();

    await (await createMermaidRenderer(CONFIG, { launch: fake.launch, env: {}, isRoot: false })).close();

    expect(fake.launches[0]?.options.args).not.toContain("--no-sandbox");
  });

  it("adds --no-sandbox when the build runs as root", async () => {
    const fake = fakeLauncher();

    await (await createMermaidRenderer(CONFIG, { launch: fake.launch, env: {}, isRoot: true })).close();

    expect(fake.launches[0]?.options.args).toContain("--no-sandbox");
  });

  it("adds --no-sandbox when MERMAID_NO_SANDBOX=1, and only for 1", async () => {
    const [on, off, other] = [fakeLauncher(), fakeLauncher(), fakeLauncher()];

    await (await createMermaidRenderer(CONFIG, { launch: on.launch, env: { MERMAID_NO_SANDBOX: "1" }, isRoot: false })).close();
    await (await createMermaidRenderer(CONFIG, { launch: off.launch, env: { MERMAID_NO_SANDBOX: "0" }, isRoot: false })).close();
    await (await createMermaidRenderer(CONFIG, { launch: other.launch, env: { MERMAID_NO_SANDBOX: "true" }, isRoot: false })).close();

    expect(on.launches[0]?.options.args).toContain("--no-sandbox");
    expect(off.launches[0]?.options.args).not.toContain("--no-sandbox");
    expect(other.launches[0]?.options.args).not.toContain("--no-sandbox");
  });

  it("gives the same flags from launchArguments, whatever the order of the cases", () => {
    expect(launchArguments({}, false)).toEqual(["--host-resolver-rules=MAP * ~NOTFOUND", "--font-render-hinting=none"]);
    expect(launchArguments({ MERMAID_NO_SANDBOX: "1" }, true)).toEqual(["--host-resolver-rules=MAP * ~NOTFOUND", "--font-render-hinting=none", "--no-sandbox"]);
  });

  it("removes the temporary profile when it is closed", async () => {
    const fake = fakeLauncher();
    const renderer = await createMermaidRenderer(CONFIG, { launch: fake.launch, env: {}, isRoot: false });
    const profile = fake.launches[0]?.options.userDataDir as string;
    expect(existsSync(profile)).toBe(true);

    await renderer.close();

    expect(existsSync(profile)).toBe(false);
    expect(fake.browsers[0]?.closed).toBe(true);
  });
});

describe("the failures of a drawing", () => {
  it("is 30 seconds for the time limit", () => {
    expect(RENDER_TIMEOUT_MS).toBe(30_000);
  });

  it("makes a drawing that takes too long a timeout error that says so, closes that browser, and starts a new one for the next diagram", async () => {
    const fake = fakeLauncher();
    const renderer = await createMermaidRenderer(CONFIG, { launch: fake.launch, env: {}, isRoot: false, timeoutMs: 50 });
    const firstProfile = fake.launches[0]?.options.userDataDir as string;

    const error = await renderer.render("graph TD\n A --> B").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DiagramRenderError);
    expect((error as DiagramRenderError).kind).toBe("timeout");
    expect((error as DiagramRenderError).message).toMatch(/took longer than 0\.05 seconds/);
    expect(fake.browsers[0]?.closed).toBe(true);
    expect(existsSync(firstProfile)).toBe(false);

    const second = await renderer.render("graph TD\n A --> C").catch((caught: unknown) => caught);

    expect((second as DiagramRenderError).kind).toBe("timeout");
    expect(fake.launches).toHaveLength(2);
    await renderer.close();
    expect(fake.browsers.every((browser) => browser.closed)).toBe(true);
  });

  it("makes a browser that went away a crash error that says so", async () => {
    const fake = fakeLauncher(async (browser) => {
      browser.connected = false;
      throw new Error("Protocol error (Target.createTarget): Target closed");
    });
    const renderer = await createMermaidRenderer(CONFIG, { launch: fake.launch, env: {}, isRoot: false });

    const error = await renderer.render("graph TD\n A --> B").catch((caught: unknown) => caught);

    expect((error as DiagramRenderError).kind).toBe("crash");
    expect((error as DiagramRenderError).message).toMatch(/browser crashed/);
    await renderer.close();
  });

  it("makes a lost connection a crash error even when the browser still says it is connected", async () => {
    const fake = fakeLauncher(async () => {
      throw new Error("Connection closed.");
    });
    const renderer = await createMermaidRenderer(CONFIG, { launch: fake.launch, env: {}, isRoot: false });

    const error = await renderer.render("graph TD\n A --> B").catch((caught: unknown) => caught);

    expect((error as DiagramRenderError).kind).toBe("crash");
    await renderer.close();
  });

  it("makes any other error of the page an error with Mermaid's text, without the stack", async () => {
    const fake = fakeLauncher(async () => {
      throw new Error("Parse error on line 3:\n...A --> B C -->\n-----^\nExpecting 'AMP', got 'EOF'\nParser.parseError (https://mermaid-cli-intercept.invalid/tmp/x/node_modules/mermaid/chunk.mjs:1:2)");
    });
    const renderer = await createMermaidRenderer(CONFIG, { launch: fake.launch, env: {}, isRoot: false });

    const error = await renderer.render("graph TD\n A --> B").catch((caught: unknown) => caught);

    expect((error as DiagramRenderError).kind).toBe("mermaid");
    expect((error as DiagramRenderError).message).toBe("Parse error on line 3:\n...A --> B C -->\n-----^\nExpecting 'AMP', got 'EOF'");
    await renderer.close();
  });
});

describe("Mermaid's message", () => {
  it("is Mermaid's own text up to the stack trace", () => {
    const raw = [
      "Parse error on line 3:",
      "...ram A->>B: hi B->>: oops",
      "---------------------^",
      "Expecting 'link', '+', '-', '()', 'ACTOR', got 'TXT'",
      "Parser.parseError (https://mermaid-cli-intercept.invalid/tmp/claude-0/work/node_modules/mermaid/dist/chunks/mermaid.esm/sequenceDiagram.mjs:410:21)",
      "    at #evaluate (file:///tmp/claude-0/work/node_modules/puppeteer-core/lib/ExecutionContext.js:402:19)",
    ].join("\n");

    expect(mermaidMessage(raw)).toBe(["Parse error on line 3:", "...ram A->>B: hi B->>: oops", "---------------------^", "Expecting 'link', '+', '-', '()', 'ACTOR', got 'TXT'"].join("\n"));
  });

  it("stops at a frame of the form `name (<anonymous>)` and at `at ...` lines", () => {
    expect(mermaidMessage("Bad value\nArray.map (<anonymous>)\nmore")).toBe("Bad value");
    expect(mermaidMessage("Bad value\n    at foo (bar.js:1:1)\nmore")).toBe("Bad value");
  });

  it("holds no absolute path and no URL, even when the text has one", () => {
    const text = mermaidMessage("Failed to load https://example.com/x.png from /home/user/work/a.mmd and C:\\Users\\me\\a.mmd and file:///tmp/x");

    expect(text).not.toMatch(/https?:|file:|\/home|C:\\|\/tmp/);
    expect(text).toContain("<url>");
    expect(text).toContain("<path>");
  });

  it("does not take a short relative text with slashes, such as a label, for a path", () => {
    expect(mermaidMessage("Expecting 'A/B', got 'x/y'")).toBe("Expecting 'A/B', got 'x/y'");
  });

  it("says that Mermaid gave no reason when there is no text", () => {
    expect(mermaidMessage("")).toBe("Mermaid gave no reason");
    expect(mermaidMessage("Parser.parseError (https://x.invalid/a.mjs:1:1)")).toBe("Mermaid gave no reason");
  });

  it("reads the text of the error drawing that Mermaid writes for some syntax errors, and nothing from a normal diagram", () => {
    const error =
      '<svg id="diagram" role="graphics-document document" aria-roledescription="error"><g><text class="error-text" x="1">Syntax error in text</text><text class="error-text" x="1">mermaid version 12.2.0</text><text class="error-text" x="1">Parsing failed: Parse error on line 3, column 6:</text><text class="error-text" x="1">Expecting token of type \':\' but found `2`.</text></g></svg>';

    expect(errorTextOfSvg(error)).toBe("Parsing failed: Parse error on line 3, column 6: Expecting token of type ':' but found `2`.");
    expect(errorTextOfSvg('<svg id="diagram" aria-roledescription="flowchart-v2"><text class="error-text">x</text></svg>')).toBeUndefined();
  });
});
