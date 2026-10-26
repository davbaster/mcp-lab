import { describe, expect, it } from "vitest";
import { readQuiz } from "./quizData";

const question = (extra: Record<string, unknown> = {}) => ({ id: "q1", text: "What?", options: [{ id: "a", text: "A" }], ...extra });
const read = (extra: Record<string, unknown>) => readQuiz({ questions: [question(extra)] })?.questions[0];

describe("readQuiz, the snippet", () => {
  it("reads the snippet's code and language", () => {
    expect(read({ snippet: { language: "python", code: "x = 1\n" } })).toMatchObject({ code: "x = 1\n", language: "python" });
  });

  it("gives no code and no language for a question without a snippet", () => {
    expect(read({ snippet: null })).toMatchObject({ code: null, language: null });
    expect(read({})).toMatchObject({ code: null, language: null });
  });

  it.each([
    ["missing", { code: "x = 1" }],
    ["not a string", { language: 3, code: "x = 1" }],
    ["null", { language: null, code: "x = 1" }],
    ["an object", { language: { name: "python" }, code: "x = 1" }],
    ["empty", { language: "", code: "x = 1" }],
  ])("keeps the question and its code when the language is %s", (_name, snippet) => {
    expect(read({ snippet })).toMatchObject({ code: "x = 1", language: null });
  });

  it("still rejects a snippet without code, as before", () => {
    expect(readQuiz({ questions: [question({ snippet: { language: "python" } })] })).toBeNull();
    expect(readQuiz({ questions: [question({ snippet: { language: "python", code: 3 } })] })).toBeNull();
  });

  it("reads only id, text, code, language and the options' id and text", () => {
    const sentinel = "CORRECT-SENTINEL-7f3a";
    const quiz = readQuiz({
      correct: sentinel,
      questions: [
        {
          id: "q1",
          text: "What?",
          correct: sentinel,
          explanation: sentinel,
          lesson: sentinel,
          snippet: { language: "python", code: "x = 1", correct: sentinel, explanation: sentinel },
          options: [{ id: "a", text: "A", correct: sentinel, explanation: sentinel }],
        },
      ],
    });

    expect(quiz).toEqual({
      questions: [{ id: "q1", text: "What?", code: "x = 1", language: "python", options: [{ id: "a", text: "A" }] }],
    });
    expect(JSON.stringify(quiz)).not.toContain(sentinel);
  });
});
