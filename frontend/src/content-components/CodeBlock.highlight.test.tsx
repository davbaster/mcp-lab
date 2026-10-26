import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { apiRoutes } from "../test/apiRoutes";
import { QUIZ_URL, makeQuiz, quizRoutes } from "../test/quizFixtures";
import { renderApp } from "../test/renderApp";
import { renderTree, spyOnConsole } from "../test/renderTree";
import { SAMPLES } from "./codeSamples";

// The real highlighter (Shiki) here, as the learner gets it.
const fence = (lang: string | undefined, value: string) => ({ type: "code", ...(lang !== undefined && { lang }), value });
const LANGUAGE_OF: Record<string, string> = {
  "sample.py": "python",
  "sample.toml": "toml",
  "sample.json": "json",
  "sample.yaml": "yaml",
  "sample.md": "markdown",
  "sample.sh": "bash",
};

describe("a lesson fence with the real highlighter", () => {
  it.each(Object.entries(SAMPLES))("shows %s with colors and with exactly the text of the code", async (path, value) => {
    const log = spyOnConsole();
    const { container } = renderTree([fence(LANGUAGE_OF[path], value)]);
    const pre = container.querySelector("pre") as HTMLElement;
    const code = pre.querySelector("code") as HTMLElement;
    expect(code.textContent).toBe(value);
    expect(code.children).toHaveLength(0);

    await waitFor(() => expect(code.querySelector("span")).not.toBeNull());

    // The same nodes, the same text; only spans with token classes came.
    expect(container.querySelector("pre")).toBe(pre);
    expect(pre.querySelector("code")).toBe(code);
    expect(code.textContent).toBe(value);
    expect(Array.from(code.querySelectorAll("*")).every((child) => child.tagName === "SPAN" && /^code-/.test(child.className))).toBe(true);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("colors a fence in the language of a different letter case", async () => {
    const { container } = renderTree([fence("PY", "def f():\n    return 1\n")]);
    await waitFor(() => expect(container.querySelector("code .code-token-keyword")).not.toBeNull());
  });

  it.each([
    ["python", "<script>alert(1)</script>\n"],
    ["python", "</code></pre><img src=x onerror=alert(1)>\n"],
    ["markdown", "# Title\n</code></pre>&lt;img src=x onerror=alert(1)&gt;'\n"],
    ["bash", '<img src=x onerror="alert(1)">\n'],
    ["json", '&amp; "</code>"\n'],
    [undefined, "<script>alert(1)</script>"],
    ["text", "</code></pre><img src=x onerror=alert(1)>"],
  ])("shows markup in a %s fence as text and creates no element from it", async (lang, value) => {
    const { container } = renderTree([fence(lang, value)]);
    if (lang === "python" || lang === "markdown" || lang === "bash" || lang === "json") {
      await waitFor(() => expect(container.querySelector("code > span")).not.toBeNull());
    }

    expect(container.querySelector("code")?.textContent).toBe(value);
    expect(container.querySelector("script, img")).toBeNull();
    expect(container.querySelectorAll("pre")).toHaveLength(1);
    expect(container.querySelectorAll("code *:not(span)")).toHaveLength(0);
  });

  it("leaves a fence in another language as plain text with no color", async () => {
    const { container } = renderTree([fence("javascript", "const x = 'y';\n")]);
    await new Promise((done) => setTimeout(done, 50));
    expect(container.querySelector("code > *")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe("const x = 'y';\n");
  });

  it("shows empty lines and the lack of a final newline as the code has them", async () => {
    const values = ["a = 1\n\nb = 2", "a = 1\n\n\n", "\n\na = 1", "a = 1"];
    const { container } = renderTree(values.map((value) => fence("python", value)));
    await waitFor(() => expect(container.querySelectorAll("code > span").length).toBeGreaterThan(0));
    await waitFor(() => expect(Array.from(container.querySelectorAll("pre")).every((pre) => pre.querySelector("span") !== null)).toBe(true));

    expect(Array.from(container.querySelectorAll("code")).map((code) => code.textContent)).toEqual(values);
  });
});

describe("a quiz snippet with the real highlighter", () => {
  async function showSnippets(...snippets: { language: string; code: string }[]) {
    const quiz = makeQuiz();
    snippets.forEach((snippet, index) => {
      quiz.questions[index].snippet = snippet;
    });
    apiRoutes(quizRoutes(quiz));
    const view = renderApp(QUIZ_URL);
    await screen.findByRole("group", { name: /^Question 1\b/ });
    return view;
  }

  it.each(Object.entries(SAMPLES))("shows the snippet %s with colors and exactly its code, final newline included", async (path, code) => {
    const log = spyOnConsole();
    await showSnippets({ language: LANGUAGE_OF[path], code });
    const pre = screen.getByRole("region", { name: "Code for question 1" });
    const inner = pre.querySelector("code") as HTMLElement;
    expect(inner.textContent).toBe(code);

    await waitFor(() => expect(inner.querySelector("span")).not.toBeNull());

    expect(screen.getByRole("region", { name: "Code for question 1" })).toBe(pre);
    expect(pre.querySelector("code")).toBe(inner);
    expect(inner.textContent).toBe(code);
    expect(code.endsWith("\n")).toBe(true);
    expect(Array.from(inner.querySelectorAll("*")).every((child) => child.tagName === "SPAN" && /^code-/.test(child.className))).toBe(true);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
