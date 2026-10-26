import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { apiRoutes } from "../test/apiRoutes";
import { jsonResponse } from "../test/mockApi";
import { component, paragraph, renderTree, text } from "../test/renderTree";
import golden from "./fixtures/chapter-code.response.json";

/**
 * What Shiki's modules are asked to do. The modules are stand-ins that count: a module's factory
 * runs when it is first imported, and `loadLanguage` runs once for each grammar the highlighter
 * loads. The tests run in this order, in one module registry, on purpose: the first one proves
 * that nothing was imported before a viewer needed it.
 */
const seen = vi.hoisted(() => ({ imported: [] as string[], grammars: [] as string[] }));

function grammar(name: string) {
  seen.imported.push(`@shikijs/langs/${name}`);
  return { default: [{ name }] };
}

vi.mock("shiki/core", () => {
  seen.imported.push("shiki/core");
  return {
    createCssVariablesTheme: () => ({ name: "css-variables" }),
    createHighlighterCore: async () => ({
      loadLanguage: async (module: { default: { name: string }[] }) => {
        seen.grammars.push(module.default[0].name);
      },
      codeToTokensBase: (code: string) => code.split("\n").map((line) => [{ content: line, color: "var(--shiki-token-keyword)" }]),
    }),
  };
});
vi.mock("shiki/engine/javascript", () => {
  seen.imported.push("shiki/engine/javascript");
  return { createJavaScriptRegexEngine: () => ({}) };
});
vi.mock("@shikijs/langs/python", () => grammar("python"));
vi.mock("@shikijs/langs/toml", () => grammar("toml"));
vi.mock("@shikijs/langs/json", () => grammar("json"));
vi.mock("@shikijs/langs/yaml", () => grammar("yaml"));
vi.mock("@shikijs/langs/markdown", () => grammar("markdown"));
vi.mock("@shikijs/langs/shellscript", () => grammar("shellscript"));

const CODE = "GET /api/courses/sample-course/chapters/01-first-steps/code";
const IDS = { courseId: "sample-course", chapterId: "01-first-steps" };

function serve(...files: [string, string][]) {
  const data = structuredClone(golden);
  data.steps = [{ step: 1, files: files.map(([path, content]) => ({ path, status: "added", content, changed_lines: [] })) }];
  return apiRoutes({ [CODE]: () => jsonResponse(data) });
}

describe("loading Shiki on demand", () => {
  it("imports no part of Shiki for a lesson without CodeSteps", async () => {
    const api = serve();
    renderTree([paragraph(text("Only text.")), component("Callout", { type: "note" }, [paragraph(text("A note."))])], { lesson: IDS });
    expect(screen.getByText("Only text.")).toBeTruthy();
    await new Promise((done) => setTimeout(done, 50));

    expect(seen.imported).toEqual([]);
    expect(seen.grammars).toEqual([]);
    expect(api.calls()).toHaveLength(0);
  });

  it("imports no part of Shiki while the code is loading or has failed", async () => {
    apiRoutes({ [CODE]: () => new Promise<Response>(() => {}) });
    renderTree([component("CodeSteps", { step: "1" })], { lesson: IDS });
    expect(await screen.findByRole("status")).toBeTruthy();
    await new Promise((done) => setTimeout(done, 50));
    expect(seen.imported).toEqual([]);
  });

  it("loads the core and only the Python grammar for two .py tabs, once, and no grammar for a .txt tab", async () => {
    serve(["a.py", "a = 1\n"], ["b.py", "b = 2\n"], ["notes.txt", "plain\n"]);
    const { user } = renderTree([component("CodeSteps", { step: "1" })], { lesson: IDS });
    await screen.findByRole("tablist");
    await waitFor(() => expect(seen.grammars).toEqual(["python"]));

    await user.click(screen.getByRole("tab", { name: "b.py" }));
    await screen.findByRole("region", { name: "b.py" });
    await waitFor(() => expect(document.querySelector(".code-token-keyword")).not.toBeNull());
    await user.click(screen.getByRole("tab", { name: "notes.txt" }));
    await screen.findByRole("region", { name: "notes.txt" });
    await new Promise((done) => setTimeout(done, 50));

    expect(seen.grammars).toEqual(["python"]);
    expect([...seen.imported].sort()).toEqual(["@shikijs/langs/python", "shiki/core", "shiki/engine/javascript"]);
    // The plain file got no colors.
    expect(document.querySelector(".code-token-keyword")).toBeNull();
  });

  it("loads another grammar the first time a file in that language is shown", async () => {
    serve(["a.py", "a = 1\n"], ["config.toml", "a = 1\n"]);
    const { user } = renderTree([component("CodeSteps", { step: "1" })], { lesson: IDS });
    await screen.findByRole("tablist");
    expect(seen.grammars).toEqual(["python"]);
    expect(seen.imported).not.toContain("@shikijs/langs/toml");

    await user.click(screen.getByRole("tab", { name: "config.toml" }));

    await waitFor(() => expect(seen.grammars).toEqual(["python", "toml"]));
    expect(seen.imported).not.toContain("@shikijs/langs/json");
  });
});
