import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import codeBlockSource from "../content-components/CodeBlock.tsx?raw";
import { splitLines } from "../content-components/codeLines";
import { highlight } from "../content-components/highlighter";
import quizFormSource from "../quiz/QuizForm.tsx?raw";
import { readQuiz } from "../quiz/quizData";
import { apiRoutes } from "../test/apiRoutes";
import { jsonResponse } from "../test/mockApi";
import { CORRECT, EXPLANATION, grade, makeQuiz, QUIZ_URL, quizRoutes } from "../test/quizFixtures";
import { renderApp } from "../test/renderApp";
import { renderTree, spyOnConsole } from "../test/renderTree";

// The real highlighter is tested in CodeBlock.highlight.test.tsx. Here it is a stand-in that colors
// every line, and records what it is asked for.
vi.mock("../content-components/highlighter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../content-components/highlighter")>()),
  highlight: vi.fn(async (content: string) => splitLines(content).map((line) => [{ text: line.text, className: "code-token-keyword" }])),
}));

const OPTION_SENTINEL = "OPTION-CORRECT-SENTINEL-7f3a";
const LESSON_SENTINEL = "LESSON-SENTINEL-7f3a";

function quizWith(...snippets: ({ language?: unknown; code: string } | null)[]) {
  const quiz = makeQuiz();
  snippets.forEach((snippet, index) => {
    quiz.questions[index].snippet = snippet as never;
  });
  return quiz;
}

async function show(quiz: unknown, extra: Record<string, never> = {}) {
  apiRoutes({ ...quizRoutes(quiz), ...extra });
  const view = renderApp(QUIZ_URL);
  await screen.findByRole("group", { name: /^Question 1\b/ });
  return view;
}
const snippet = (n: number) => screen.getByRole("region", { name: `Code for question ${n}` });

describe("a quiz snippet", () => {
  it("is plain text first and then colored, in the same pre and code, with the same classes as a lesson fence", async () => {
    vi.mocked(highlight).mockClear();
    await show(quizWith({ language: "python", code: "def f():\n    return 1\n" }));
    const pre = snippet(1);
    const code = pre.querySelector("code") as HTMLElement;
    expect(code.textContent).toBe("def f():\n    return 1\n");

    await waitFor(() => expect(code.querySelector(".code-token-keyword")).not.toBeNull());

    expect(snippet(1)).toBe(pre);
    expect(pre.querySelector("code")).toBe(code);
    expect(code.textContent).toBe("def f():\n    return 1\n");
    expect(pre.className).toBe("quiz-snippet");
    expect(highlight).toHaveBeenCalledWith("def f():\n    return 1\n", "python");
    // The lesson fence gets the same classes from the same function.
    const lesson = renderTree([{ type: "code", lang: "python", value: "def f():\n    return 1\n" }]);
    await waitFor(() => expect(lesson.container.querySelector("code .code-token-keyword")).not.toBeNull());
    expect(lesson.container.querySelector("code")?.innerHTML.replaceAll(/\s+/g, " ")).toBe(code.innerHTML.replaceAll(/\s+/g, " "));
  });

  it.each([
    ["an unknown language", { language: "text", code: "a\n" }],
    ["a language that is not a string", { language: 3, code: "a\n" }],
    ["an empty language", { language: "", code: "a\n" }],
    ["no language", { code: "a\n" }],
    ["a name with a space", { language: "py thon", code: "a\n" }],
  ])("stays plain text with %s, asks for no colors and logs nothing", async (_name, snip) => {
    vi.mocked(highlight).mockClear();
    const log = spyOnConsole();
    await show(quizWith(snip));
    await new Promise((done) => setTimeout(done, 30));

    expect(snippet(1).textContent).toBe("a\n");
    expect(snippet(1).querySelector("code > *")).toBeNull();
    expect(highlight).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("has no Copy button, and is a focusable region named by its question", async () => {
    await show(quizWith({ language: "python", code: "a = 1\n" }, { language: "json", code: "{}\n" }));
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
    for (const n of [1, 2]) {
      expect(snippet(n).tabIndex).toBe(0);
      expect(snippet(n).tagName).toBe("PRE");
    }
  });

  it("is highlighted by the shared block, whose module imports the stylesheet with the token colors", () => {
    expect(codeBlockSource).toMatch(/import\s+"\.\/content\.css";/);
    expect(quizFormSource).toMatch(/import\s*\{\s*CodeBlock\s*\}\s*from\s*"\.\.\/content-components\/CodeBlock"/);
    expect(quizFormSource).not.toMatch(/<pre\b/);
  });
});

describe("no answer key reaches the snippet's highlighter, the page or the log", () => {
  function leakyQuiz() {
    const quiz = quizWith({ language: "python", code: "x = 1\n" });
    const leaky = { correct: CORRECT, explanation: EXPLANATION, lesson: LESSON_SENTINEL };
    return {
      ...quiz,
      questions: quiz.questions.map((q) => ({
        ...q,
        ...leaky,
        snippet: q.snippet === null ? null : { ...q.snippet, ...leaky },
        options: q.options.map((o) => ({ ...o, correct: OPTION_SENTINEL })),
      })),
    };
  }
  const sentinels = [CORRECT, EXPLANATION, LESSON_SENTINEL, OPTION_SENTINEL];

  it("does not copy any of those fields out of the response", () => {
    expect(JSON.stringify(readQuiz(leakyQuiz()))).not.toMatch(/SENTINEL/);
  });

  it("calls the highlighter only with snippet code, and puts no sentinel in the DOM or the console", async () => {
    vi.mocked(highlight).mockClear();
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")].map((spy) => spy.mockImplementation(() => {}));
    await show(leakyQuiz());
    await waitFor(() => expect(snippet(1).querySelector(".code-token-keyword")).not.toBeNull());

    expect(vi.mocked(highlight).mock.calls).toEqual([["x = 1\n", "python"]]);
    for (const sentinel of sentinels) {
      expect(document.body.innerHTML).not.toContain(sentinel);
      expect(JSON.stringify(vi.mocked(highlight).mock.calls)).not.toContain(sentinel);
      for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(sentinel);
    }
  });

  const answerAll = async (user: ReturnType<typeof renderApp>["user"], wrongFrom: number) => {
    for (let n = 1; n <= 5; n++) {
      const group = screen.getByRole("group", { name: new RegExp(`^Question ${n}\\b`) });
      await user.click(within(group).getByRole("radio", { name: n >= wrongFrom ? `Q${n} option b` : `Q${n} option a` }));
    }
    await user.click(screen.getByRole("button", { name: "Submit answers" }));
  };

  it.each([
    ["a failed attempt", 1, /^You scored 0\/5/],
    ["a passed attempt", 99, /^You passed with 5\/5/],
  ])("asks the highlighter for nothing more on the review after %s", async (_name, wrongFrom, title) => {
    vi.mocked(highlight).mockClear();
    const view = await show(makeQuiz(), {
      "POST /api/courses/demo/chapters/c1/quiz/attempts": ((call: never) => jsonResponse(grade(call))) as never,
    });
    await waitFor(() => expect(highlight).toHaveBeenCalledTimes(1));

    await answerAll(view.user, wrongFrom);
    expect(await screen.findByRole("heading", { level: 2, name: title })).toBeTruthy();
    await new Promise((done) => setTimeout(done, 30));

    expect(highlight).toHaveBeenCalledTimes(1);
    expect(document.querySelector("main pre")).toBeNull();
  });
});
