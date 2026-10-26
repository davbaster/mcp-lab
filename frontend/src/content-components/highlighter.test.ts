import { describe, expect, it, vi } from "vitest";
import { SAMPLES } from "./codeSamples";
import { splitLines } from "./codeLines";
import { createHighlighter, highlight, languageForPath, MAX_HIGHLIGHT_CHARS, type HighlighterModules } from "./highlighter";

describe("languageForPath", () => {
  it.each([
    ["main.py", "python"],
    ["pyproject.toml", "toml"],
    ["data.json", "json"],
    ["config.yaml", "yaml"],
    ["config.yml", "yaml"],
    ["README.md", "markdown"],
    ["run.sh", "shellscript"],
    ["run.bash", "shellscript"],
    // The extension is compared in lower case.
    ["MAIN.PY", "python"],
    ["Readme.Md", "markdown"],
    ["SCRIPT.Bash", "shellscript"],
    // Only the last path segment and the text after its last dot count.
    ["src/pkg.py/readme", null],
    ["pkg.d/util.py", "python"],
    ["a.tar.py", "python"],
    ["a..py", "python"],
    ["x.json.txt", null],
    // No extension, a name that only starts with a dot, and other files are plain text.
    ["Dockerfile", null],
    ["src/Makefile", null],
    [".toml", null],
    [".env", null],
    ["src/.toml", null],
    ["notes.txt", null],
    ["file.", null],
    ["", null],
    ["a.toString", null],
    ["a.constructor", null],
    ["a.__proto__", null],
  ])("maps %j to %j", (path, language) => {
    expect(languageForPath(path)).toBe(language);
  });
});

/** Stand-ins for Shiki, to count what is loaded. */
function fakeModules() {
  const loaded: string[] = [];
  const created = vi.fn();
  const modules: HighlighterModules = {
    core: vi.fn(async () => ({
      createCssVariablesTheme: () => ({ name: "css-variables" }),
      createHighlighterCore: async () => {
        created();
        return {
          loadLanguage: async (grammar: { name: string }) => {
            loaded.push(grammar.name);
          },
          codeToTokensBase: (code: string) => code.split("\n").map((text) => [{ content: text, color: "var(--shiki-token-keyword)" }]),
        };
      },
    })) as never,
    engine: vi.fn(async () => ({ createJavaScriptRegexEngine: () => ({}) })) as never,
    grammars: {
      python: vi.fn(async () => ({ name: "python" })),
      toml: vi.fn(async () => ({ name: "toml" })),
      json: vi.fn(async () => ({ name: "json" })),
      yaml: vi.fn(async () => ({ name: "yaml" })),
      markdown: vi.fn(async () => ({ name: "markdown" })),
      shellscript: vi.fn(async () => ({ name: "shellscript" })),
    },
  };
  return { modules, loaded, created };
}

describe("loading on demand", () => {
  it("imports nothing until text is highlighted", () => {
    const { modules } = fakeModules();
    createHighlighter(modules);
    expect(modules.core).not.toHaveBeenCalled();
    expect(modules.engine).not.toHaveBeenCalled();
    for (const load of Object.values(modules.grammars)) expect(load).not.toHaveBeenCalled();
  });

  it("loads the core once and a grammar once, however many files use it", async () => {
    const { modules, loaded, created } = fakeModules();
    const { highlight: run } = createHighlighter(modules);

    await run("a = 1\n", "python");
    await run("b = 2\n", "python");
    await Promise.all([run("c = 3\n", "python"), run("d = 4\n", "python")]);

    expect(created).toHaveBeenCalledTimes(1);
    expect(modules.grammars.python).toHaveBeenCalledTimes(1);
    expect(loaded).toEqual(["python"]);
    // No other grammar was asked for.
    for (const [language, load] of Object.entries(modules.grammars)) {
      if (language !== "python") expect(load).not.toHaveBeenCalled();
    }
  });

  it("loads the grammar of a second language when that file is shown", async () => {
    const { modules, loaded } = fakeModules();
    const { highlight: run } = createHighlighter(modules);

    await run("a = 1\n", "python");
    await run("a = 1\n", "toml");

    expect(loaded).toEqual(["python", "toml"]);
  });

  it("does not load anything for text over the limit", async () => {
    const { modules } = fakeModules();
    const { highlight: run } = createHighlighter(modules);
    expect(await run("x".repeat(MAX_HIGHLIGHT_CHARS + 1), "python")).toBeNull();
    expect(modules.core).not.toHaveBeenCalled();
  });

  it("keeps the text plain, warns once and does not log an error when the core cannot be loaded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { modules } = fakeModules();
    modules.core = vi.fn(async () => {
      throw new TypeError("Failed to fetch dynamically imported module SECRET-CONTENT");
    });
    const { highlight: run } = createHighlighter(modules);

    expect(await run("a = 1\n", "python")).toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain("SECRET-CONTENT");
    expect(error).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("keeps the text plain when a grammar cannot be loaded, and tries again the next time", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { modules, loaded } = fakeModules();
    const failing = vi.fn().mockRejectedValueOnce(new Error("blocked")).mockResolvedValue({ name: "python" });
    modules.grammars = { ...modules.grammars, python: failing };
    const { highlight: run } = createHighlighter(modules);

    expect(await run("a = 1\n", "python")).toBeNull();
    expect(await run("a = 1\n", "python")).not.toBeNull();
    expect(loaded).toEqual(["python"]);
    vi.restoreAllMocks();
  });

  it("keeps the text plain when tokenizing throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { modules } = fakeModules();
    modules.core = vi.fn(async () => ({
      createCssVariablesTheme: () => ({ name: "css-variables" }),
      createHighlighterCore: async () => ({
        loadLanguage: async () => {},
        codeToTokensBase: () => {
          throw new RangeError("Invalid regular expression");
        },
      }),
    })) as never;
    const { highlight: run } = createHighlighter(modules);

    expect(await run("a = 1\n", "python")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("keeps the text plain when the tokens do not add up to the text", async () => {
    const { modules } = fakeModules();
    modules.core = vi.fn(async () => ({
      createCssVariablesTheme: () => ({ name: "css-variables" }),
      createHighlighterCore: async () => ({
        loadLanguage: async () => {},
        codeToTokensBase: () => [[{ content: "changed", color: "var(--shiki-token-keyword)" }]],
      }),
    })) as never;
    const { highlight: run } = createHighlighter(modules);

    expect(await run("a = 1\n", "python")).toBeNull();
  });

  it("returns no lines for empty text without loading anything", async () => {
    const { modules } = fakeModules();
    const { highlight: run } = createHighlighter(modules);
    expect(await run("", "python")).toEqual([]);
    expect(modules.core).not.toHaveBeenCalled();
  });
});

const named = Object.entries(SAMPLES);

describe("the real highlighter", () => {
  it.each(named)("keeps the text of %s exactly", async (path, content) => {
    const language = languageForPath(path);
    expect(language).not.toBeNull();
    const lines = await highlight(content, language!);

    expect(lines).not.toBeNull();
    const expected = splitLines(content).map((line) => line.text);
    expect(lines!.map((tokens) => tokens.map((token) => token.text).join(""))).toEqual(expected);
    // Joined with the line breaks, it is the file.
    expect(lines!.map((tokens) => tokens.map((token) => token.text).join("")).join("\n") + "\n").toBe(content);
  });

  it.each(named)("colors some of the tokens of %s with a fixed class", async (path, content) => {
    const lines = await highlight(content, languageForPath(path)!);
    const classes = new Set(lines!.flat().map((token) => token.className).filter((name) => name !== null));
    expect(classes.size).toBeGreaterThan(0);
    for (const name of classes) expect(name).toMatch(/^(code-(token-[a-z-]+|italic|bold|underline))( code-(token-[a-z-]+|italic|bold|underline))*$/);
  });

  it("uses a color class for a keyword and a string in Python", async () => {
    const lines = await highlight('import os\nx = "a"\n', "python");
    const byText = new Map(lines!.flat().map((token) => [token.text, token.className]));
    expect(byText.get("import")).toBe("code-token-keyword");
    expect(byText.get('"a"')).toBe("code-token-string-expression");
  });

  it("highlights text of exactly the limit and not one character more", async () => {
    // "a = 1" lines of 6 characters each, cut to the exact length.
    const line = "a = 1\n";
    const exact = line.repeat(Math.ceil(MAX_HIGHLIGHT_CHARS / line.length)).slice(0, MAX_HIGHLIGHT_CHARS - 1) + "\n";
    expect(exact).toHaveLength(MAX_HIGHLIGHT_CHARS);

    expect(await highlight(exact, "toml")).not.toBeNull();
    expect(await highlight(exact + "x", "toml")).toBeNull();
  }, 30_000);

  it("keeps a lone carriage return inside its line, so no line is added", async () => {
    const lines = await highlight("a = 1\rb = 2\n", "toml");
    expect(lines).toHaveLength(1);
    expect(lines![0].map((token) => token.text).join("")).toBe("a = 1\rb = 2");
  });

  it("does not turn markup in the file into anything but text", async () => {
    const content = "<script>alert(1)</script>\n</code></pre>&lt;img src=x onerror=alert(1)&gt;'\n";
    const lines = await highlight(content, "markdown");
    expect(lines!.flat().map((token) => token.text).join("")).toBe("<script>alert(1)</script></code></pre>&lt;img src=x onerror=alert(1)&gt;'");
  });
});
