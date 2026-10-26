import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { apiRoutes } from "../test/apiRoutes";
import { jsonResponse } from "../test/mockApi";
import { makeQuiz, QUIZ_URL, quizRoutes } from "../test/quizFixtures";
import { component, renderTree, spyOnConsole } from "../test/renderTree";
import { renderApp } from "../test/renderApp";
import golden from "./fixtures/chapter-code.response.json";
import { MAX_HIGHLIGHT_CHARS, MAX_HIGHLIGHT_LINE_CHARS } from "./highlighter";

/**
 * What Shiki's modules are asked to do when a lesson has code fences or a quiz has snippets. The
 * modules are stand-ins that count: a module's factory runs when it is first imported, and
 * `loadLanguage` runs once for each grammar the highlighter loads. The tests run in this order, in
 * one module registry, on purpose: the first one proves that importing the lesson and quiz
 * components imported nothing, and each later one adds only what it needs (CodeSteps.lazy.test.tsx
 * does the same for the code viewer).
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

const fence = (lang: string | undefined, value: string) => ({ type: "code", ...(lang !== undefined && { lang }), value });
const settle = () => new Promise((done) => setTimeout(done, 50));
const sorted = (names: string[]) => [...names].sort();

function quizWith(...snippets: ({ language: string; code: string } | null)[]) {
  const quiz = makeQuiz();
  snippets.forEach((snippet, index) => {
    quiz.questions[index].snippet = snippet;
  });
  return quiz;
}

async function showQuiz(quiz: unknown) {
  apiRoutes(quizRoutes(quiz));
  const view = renderApp(QUIZ_URL);
  await screen.findByRole("group", { name: /^Question 1\b/ });
  return view;
}

describe("loading Shiki on demand for code fences and quiz snippets", () => {
  it("imports no part of Shiki for a lesson with no fenced code", async () => {
    renderTree([component("Callout", { type: "note" }, [])]);
    await settle();
    expect(seen.imported).toEqual([]);
    expect(seen.grammars).toEqual([]);
  });

  it("imports no part of Shiki for fences with no or an unsupported language, or with too much code", async () => {
    const log = spyOnConsole();
    const { container } = renderTree([
      fence(undefined, "plain"),
      fence("javascript", "let x = 1"),
      fence("zsh", "echo"),
      fence("python3", "x = 1"),
      fence("py thon", "x = 1"),
      fence("python", ""),
      fence("python", "x".repeat(MAX_HIGHLIGHT_CHARS + 1)),
      fence("json", "y".repeat(MAX_HIGHLIGHT_LINE_CHARS + 1)),
    ]);
    expect(container.querySelectorAll("pre")).toHaveLength(8);
    await settle();

    expect(seen.imported).toEqual([]);
    expect(seen.grammars).toEqual([]);
    expect(log.error).not.toHaveBeenCalled();
    // Only the line that is too long says so, once, and not what it holds.
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0][0])).not.toContain("yyyy");
  });

  it("imports no part of Shiki for a quiz with no snippet, or a snippet in an unsupported language or over the limits", async () => {
    await showQuiz(
      quizWith(
        null,
        { language: "text", code: "plain\n" },
        { language: "python", code: "x".repeat(MAX_HIGHLIGHT_CHARS + 1) },
        { language: "", code: "a = 1\n" },
      ),
    );
    await settle();

    expect(document.querySelectorAll("main pre")).toHaveLength(3);
    expect(seen.imported).toEqual([]);
    expect(seen.grammars).toEqual([]);
  });

  it("imports the core, the engine and the Python grammar, once, for two Python fences, and nothing else", async () => {
    const { container } = renderTree([fence("python", "a = 1"), fence("py", "b = 2"), fence(undefined, "plain")]);
    await waitFor(() => expect(container.querySelectorAll(".code-token-keyword")).toHaveLength(2));

    expect(sorted(seen.imported)).toEqual(["@shikijs/langs/python", "shiki/core", "shiki/engine/javascript"]);
    expect(seen.grammars).toEqual(["python"]);
  });

  it("imports one more grammar for a JSON fence, and the Python grammar is not loaded again", async () => {
    const { container } = renderTree([fence("python", "a = 1"), fence("JSON", "{}")]);
    await waitFor(() => expect(container.querySelectorAll(".code-token-keyword")).toHaveLength(2));

    expect(sorted(seen.imported)).toEqual(["@shikijs/langs/json", "@shikijs/langs/python", "shiki/core", "shiki/engine/javascript"]);
    expect(seen.grammars).toEqual(["python", "json"]);
  });

  it("loads the Python grammar once for a CodeSteps with .py files and a Python fence", async () => {
    const data = structuredClone(golden);
    data.steps = [{ step: 1, files: [{ path: "a.py", status: "added", content: "a = 1\n", changed_lines: [] }] }];
    apiRoutes({ "GET /api/courses/sample-course/chapters/01-first-steps/code": () => jsonResponse(data) });
    const { container } = renderTree([component("CodeSteps", { step: "1" }), fence("python", "b = 2")], {
      lesson: { courseId: "sample-course", chapterId: "01-first-steps" },
    });
    await screen.findByRole("tablist");
    await waitFor(() => expect(container.querySelectorAll(".code-token-keyword").length).toBeGreaterThanOrEqual(2));
    await settle();

    expect(seen.grammars).toEqual(["python", "json"]);
    expect(seen.imported.filter((name) => name === "@shikijs/langs/python")).toHaveLength(1);
  });

  it("imports only the grammar of a quiz snippet, on the same highlighter, and loads nothing twice", async () => {
    await showQuiz(quizWith({ language: "toml", code: "a = 1\n" }, { language: "Python", code: "x = 1\n" }));
    await waitFor(() => expect(document.querySelectorAll("main pre .code-token-keyword")).toHaveLength(2));

    expect(seen.grammars).toEqual(["python", "json", "toml"]);
    expect(sorted(seen.imported)).toEqual([
      "@shikijs/langs/json",
      "@shikijs/langs/python",
      "@shikijs/langs/toml",
      "shiki/core",
      "shiki/engine/javascript",
    ]);
  });

  it("causes one request per module under StrictMode, where effects run twice", async () => {
    const { container } = renderTree([fence("yaml", "a: 1")], { strict: true });
    await waitFor(() => expect(container.querySelector(".code-token-keyword")).not.toBeNull());
    await settle();

    expect(seen.imported.filter((name) => name === "@shikijs/langs/yaml")).toHaveLength(1);
    expect(seen.imported.filter((name) => name === "shiki/core")).toHaveLength(1);
    expect(seen.grammars).toEqual(["python", "json", "toml", "yaml"]);
  });
});
