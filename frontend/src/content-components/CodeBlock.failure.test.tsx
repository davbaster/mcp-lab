import { cleanup, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { apiRoutes } from "../test/apiRoutes";
import { makeQuiz, QUIZ_URL, quizRoutes } from "../test/quizFixtures";
import { renderApp } from "../test/renderApp";
import { renderTree, spyOnConsole } from "../test/renderTree";

/**
 * The highlighter's own failure handling, with the real `highlight`: the Python grammar's module
 * cannot be loaded (the `import()` rejects) until `state.failing` is switched off.
 */
const state = vi.hoisted(() => ({ failing: true }));

vi.mock("shiki/core", () => ({
  createCssVariablesTheme: () => ({ name: "css-variables" }),
  createHighlighterCore: async () => ({
    loadLanguage: async () => {},
    codeToTokensBase: (code: string) => code.split("\n").map((line) => [{ content: line, color: "var(--shiki-token-keyword)" }]),
  }),
}));
vi.mock("shiki/engine/javascript", () => ({ createJavaScriptRegexEngine: () => ({}) }));
vi.mock("@shikijs/langs/python", () => {
  if (state.failing) throw new Error("ERROR-SENTINEL-7f3a the grammar chunk is blocked");
  return { default: [{ name: "python" }] };
});

const SENTINEL = "CODE-SENTINEL-7f3a";
const fence = (lang: string | undefined, value: string) => ({ type: "code", ...(lang !== undefined && { lang }), value });
const settle = () => new Promise((done) => setTimeout(done, 50));

describe("when the highlighter cannot load", () => {
  it("leaves a lesson fence plain, keeps Copy working, shows no error and logs one warning without the code", async () => {
    const log = spyOnConsole();
    const { container, user } = renderTree([fence("python", `x = "${SENTINEL}"\n`), fence(undefined, "bare")]);
    await waitFor(() => expect(log.warn).toHaveBeenCalled());
    await settle();

    const [python, bare] = Array.from(container.querySelectorAll("pre"));
    expect(python.textContent).toBe(`x = "${SENTINEL}"\n`);
    expect(python.querySelector("code > *")).toBeNull();
    expect(bare.textContent).toBe("bare");
    expect(container.querySelector("[role=alert], .error-box, .content-unavailable")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Copy python code" }));
    expect(await navigator.clipboard.readText()).toBe(`x = "${SENTINEL}"\n`);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(SENTINEL);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("ERROR-SENTINEL");
  });

  it("leaves a quiz snippet plain, with the question usable and no sentinel in the log", async () => {
    const log = spyOnConsole();
    const quiz = makeQuiz();
    quiz.questions[0].snippet = { language: "python", code: `x = "${SENTINEL}"\n` };
    apiRoutes(quizRoutes(quiz));
    renderApp(QUIZ_URL);
    await screen.findByRole("group", { name: /^Question 1\b/ });
    await waitFor(() => expect(log.warn).toHaveBeenCalled());
    await settle();

    const pre = screen.getByRole("region", { name: "Code for question 1" });
    expect(pre.textContent).toBe(`x = "${SENTINEL}"\n`);
    expect(pre.querySelector("code > *")).toBeNull();
    expect(screen.getAllByRole("radio").length).toBeGreaterThan(0);
    expect(log.error).not.toHaveBeenCalled();
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(SENTINEL);
  });

  it("tries again for a later block, since a failed load is not kept", async () => {
    cleanup();
    state.failing = false;
    const { container } = renderTree([fence("python", "x = 1")]);
    await waitFor(() => expect(container.querySelector("code .code-token-keyword")).not.toBeNull());
    expect(container.querySelector("code")?.textContent).toBe("x = 1");
  });
});
