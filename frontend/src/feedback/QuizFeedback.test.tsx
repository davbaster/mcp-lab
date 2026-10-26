import { screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRoutes, deferred, type RecordedCall } from "../test/apiRoutes";
import { acceptedResponse, errorResponse, jsonResponse } from "../test/mockApi";
import { CHAPTER, COURSE, CORRECT, EXPLANATION, OPTION_ID, chapterList, grade, makeQuiz } from "../test/quizFixtures";
import { renderApp } from "../test/renderApp";
import { installConsoleBuffer, uninstallConsoleBuffer } from "./consoleBuffer";

const QUIZ_URL = `/courses/${COURSE}/chapters/${CHAPTER}/quiz`;
const FEEDBACK = "POST /api/feedback";
const PASSWORD = "PASSWORD-SENTINEL-7f3a";
const COOKIE = "COOKIE-SENTINEL-7f3a";
const OPTION_TEXT = "OPTTEXT-SENTINEL-7f3a";
const MESSAGE = "The wording of this question is confusing";

type Handler = NonNullable<Parameters<typeof apiRoutes>[0]>[string];

function setup(overrides: Record<string, Handler> = {}, quizzes: unknown[] = [makeQuiz()]) {
  let asked = 0;
  return apiRoutes({
    "GET /api/auth/me": () => jsonResponse({ username: "ada_l" }),
    [`GET /api/courses/${COURSE}/chapters/${CHAPTER}/quiz`]: () => jsonResponse(quizzes[Math.min(asked++, quizzes.length - 1)]),
    [`GET /api/courses/${COURSE}/chapters`]: () => jsonResponse(chapterList()),
    [`POST /api/courses/${COURSE}/chapters/${CHAPTER}/quiz/attempts`]: (call) => jsonResponse(grade(call)),
    [FEEDBACK]: () => acceptedResponse(),
    ...overrides,
  });
}

const headerButton = () => screen.getByRole("button", { name: "Send feedback" });
const dialog = () => screen.getByRole("dialog", { name: "Send feedback" });
const inDialog = () => within(dialog());
const group = (n: number) => screen.getByRole("group", { name: new RegExp(`^Question ${n}\\b`) });
const questionButton = (n: number) => screen.getByRole("button", { name: `Send feedback about this question (question ${n})` });
const checkbox = () => inDialog().getByRole("checkbox", { name: "This is about the current quiz question" }) as HTMLInputElement;

async function loaded(url = QUIZ_URL) {
  const view = renderApp(url);
  await screen.findByRole("group", { name: /^Question 1\b/ });
  return view;
}

/** Answers every question with the option that ends in `letter`; the text comes from `textOf`. */
async function answerAll(user: UserEvent, letter: string, textOf = (n: number) => `Q${n} option ${letter}`) {
  for (const n of [1, 2, 3, 4, 5]) await user.click(within(group(n)).getByRole("radio", { name: textOf(n) }));
}

async function submit(user: UserEvent) {
  await user.click(screen.getByRole("button", { name: "Submit answers" }));
  await screen.findByRole("heading", { level: 2 });
}

async function writeAndSend(user: UserEvent, category = "Bug") {
  await user.click(inDialog().getByRole("radio", { name: category }));
  await user.click(inDialog().getByLabelText("Message"));
  await user.paste(MESSAGE);
  await user.click(inDialog().getByRole("button", { name: "Send" }));
}

type Body = { about_quiz_question: boolean; context: Record<string, unknown> };
const bodyOf = (call: RecordedCall) => call.body as Body;

afterEach(() => {
  uninstallConsoleBuffer();
});

describe("the question buttons", () => {
  it("shows one on every question of the form, after its fieldset, with different names", async () => {
    setup();
    await loaded();

    const buttons = screen.getAllByRole("button", { name: /^Send feedback about this question/ });
    expect(buttons).toHaveLength(5);
    expect(buttons.map((b) => b.textContent)).toEqual(Array(5).fill("Send feedback about this question"));
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([1, 2, 3, 4, 5].map((n) => `Send feedback about this question (question ${n})`));
    buttons.forEach((button, index) => {
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("type")).toBe("button");
      expect(button.previousElementSibling).toBe(group(index + 1));
    });
  });

  it("does not answer or submit the quiz when it is used", async () => {
    const api = setup();
    const { user } = await loaded();
    await user.click(within(group(3)).getByRole("radio", { name: "Q3 option a" }));

    await user.click(questionButton(3));
    await user.keyboard("{Escape}");

    expect((within(group(3)).getByRole("radio", { name: "Q3 option a" }) as HTMLInputElement).checked).toBe(true);
    expect(api.calls().filter((call) => call.path.endsWith("/attempts"))).toHaveLength(0);
  });

  it("shows one on every item of a failed review", async () => {
    setup();
    const { user } = await loaded();
    await answerAll(user, "b");
    await submit(user);

    const buttons = screen.getAllByRole("button", { name: /^Send feedback about this question/ });
    expect(buttons).toHaveLength(5);
    expect(new Set(buttons.map((b) => b.getAttribute("aria-label"))).size).toBe(5);
    for (const button of buttons) expect(button.closest("li")?.classList.contains("quiz-review-item")).toBe(true);
  });

  it("shows one on every item of a passed review", async () => {
    setup();
    const { user } = await loaded();
    await answerAll(user, "a");
    await submit(user);

    const buttons = screen.getAllByRole("button", { name: /^Send feedback about this question/ });
    expect(buttons).toHaveLength(5);
    for (const button of buttons) expect(button.closest("li")?.classList.contains("quiz-review-item")).toBe(true);
    expect(questionButton(5)).toBe(buttons[4]);
  });

  it("opens the form with the box checked, and sends that question's ID", async () => {
    const api = setup();
    const { user } = await loaded();

    await user.click(questionButton(3));

    expect(checkbox().checked).toBe(true);
    await writeAndSend(user, "Content error");
    await waitFor(() => expect(api.calls(FEEDBACK)).toHaveLength(1));
    const body = bodyOf(api.calls(FEEDBACK)[0]);
    expect(body.about_quiz_question).toBe(true);
    expect(body.context).toMatchObject({
      question_id: "q3",
      course_id: COURSE,
      chapter_id: CHAPTER,
      lesson_id: null,
      page_path: QUIZ_URL,
    });
  });

  it("sends the question's ID from a review too", async () => {
    const api = setup();
    const { user } = await loaded();
    await answerAll(user, "b");
    await submit(user);

    await user.click(questionButton(4));
    await writeAndSend(user);

    await waitFor(() => expect(api.calls(FEEDBACK)).toHaveLength(1));
    expect(bodyOf(api.calls(FEEDBACK)[0]).context.question_id).toBe("q4");
    expect(bodyOf(api.calls(FEEDBACK)[0]).about_quiz_question).toBe(true);
  });

  it("sends about_quiz_question false and no question ID when the box is unchecked", async () => {
    const api = setup();
    const { user } = await loaded();
    await user.click(questionButton(2));

    await user.click(checkbox());
    expect(checkbox().checked).toBe(false);
    await writeAndSend(user);

    await waitFor(() => expect(api.calls(FEEDBACK)).toHaveLength(1));
    const body = bodyOf(api.calls(FEEDBACK)[0]);
    expect(body.about_quiz_question).toBe(false);
    expect(body.context.question_id).toBeNull();
    expect(body.context.chapter_id).toBe(CHAPTER);
  });

  it("has no box and no question when the dialog is opened from the header of a quiz page", async () => {
    const api = setup();
    const { user } = await loaded();

    await user.click(headerButton());

    expect(inDialog().queryByRole("checkbox")).toBeNull();
    await writeAndSend(user);
    await waitFor(() => expect(api.calls(FEEDBACK)).toHaveLength(1));
    const body = bodyOf(api.calls(FEEDBACK)[0]);
    expect(body.about_quiz_question).toBe(false);
    expect(body.context.question_id).toBeNull();
    expect(body.context.chapter_id).toBe(CHAPTER);
  });

  it("attaches question 4 after the dialog was opened from question 2 and closed, with the text kept and the box checked again", async () => {
    const api = setup();
    const { user } = await loaded();
    await user.click(questionButton(2));
    await user.click(checkbox());
    await user.click(inDialog().getByLabelText("Message"));
    await user.paste(MESSAGE);
    await user.click(inDialog().getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(questionButton(2));

    await user.click(questionButton(4));

    expect(checkbox().checked).toBe(true);
    expect((inDialog().getByLabelText("Message") as HTMLTextAreaElement).value).toBe(MESSAGE);
    await user.click(inDialog().getByRole("radio", { name: "Bug" }));
    await user.click(inDialog().getByRole("button", { name: "Send" }));
    await waitFor(() => expect(api.calls(FEEDBACK)).toHaveLength(1));
    expect(bodyOf(api.calls(FEEDBACK)[0]).context.question_id).toBe("q4");
  });

  it("does not leave the question in the form when it is opened from the header next", async () => {
    setup();
    const { user } = await loaded();
    await user.click(questionButton(2));
    await user.keyboard("{Escape}");

    await user.click(headerButton());

    expect(inDialog().queryByRole("checkbox")).toBeNull();
  });

  it("does not leave an old question in the form after Try again loads a new quiz", async () => {
    const api = setup({}, [makeQuiz(), makeQuiz({ tag: "n-" })]);
    const { user } = await loaded();
    await answerAll(user, "b");
    await submit(user);
    await user.click(questionButton(2));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("group", { name: /^Question 1\b/ });

    await user.click(headerButton());
    await writeAndSend(user);

    await waitFor(() => expect(api.calls(FEEDBACK)).toHaveLength(1));
    expect(bodyOf(api.calls(FEEDBACK)[0]).context.question_id).toBeNull();
    expect(inDialog().queryByRole("checkbox")).toBeNull();
  });

  it("gives focus back to the header button when the question is gone, as when the session ends", async () => {
    setup({ [FEEDBACK]: () => errorResponse(401, "not_authenticated", "Sign in to continue.") });
    const { user } = await loaded();
    await user.click(questionButton(1));
    await writeAndSend(user);
    await inDialog().findByText("Sign in to send feedback");
    // The quiz is replaced by its sign-in prompt, so the opener is gone.
    await screen.findByText("Sign in to take the quiz");
    expect(screen.queryByRole("button", { name: /about this question/ })).toBeNull();

    await user.click(inDialog().getByRole("button", { name: "Close" }));

    expect(document.activeElement).toBe(headerButton());
  });

  it("gives focus back to the question's own button on close", async () => {
    setup();
    const { user } = await loaded();

    await user.click(questionButton(5));
    await user.keyboard("{Escape}");

    expect(document.activeElement).toBe(questionButton(5));
  });
});

describe("the header button on a quiz page", () => {
  it("is there while the quiz loads", async () => {
    const quiz = deferred<Response>();
    setup({ [`GET /api/courses/${COURSE}/chapters/${CHAPTER}/quiz`]: () => quiz.promise });
    renderApp(QUIZ_URL);

    expect(await screen.findByText("Loading…")).toBeTruthy();
    expect(headerButton()).toBeTruthy();
    quiz.resolve(jsonResponse(makeQuiz()));
    await screen.findByRole("group", { name: /^Question 1\b/ });
  });

  it("is there in the form, in a failed review and in a passed review", async () => {
    setup();
    const { user } = await loaded();
    expect(headerButton()).toBeTruthy();

    await answerAll(user, "b");
    await submit(user);
    expect(headerButton()).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("group", { name: /^Question 1\b/ });
    await answerAll(user, "a");
    await submit(user);
    expect(headerButton()).toBeTruthy();
  });

  it("is there when the chapter is locked, with no question buttons", async () => {
    setup({ [`GET /api/courses/${COURSE}/chapters/${CHAPTER}/quiz`]: () => errorResponse(403, "chapter_locked", "Locked.") });
    renderApp(QUIZ_URL);

    await screen.findByText(/This chapter is locked/);
    expect(headerButton()).toBeTruthy();
    expect(screen.queryByRole("button", { name: /about this question/ })).toBeNull();
  });

  it("is there when the quiz fails to load, with no question buttons", async () => {
    setup({ [`GET /api/courses/${COURSE}/chapters/${CHAPTER}/quiz`]: () => errorResponse(500, "internal_error", "Broke.") });
    renderApp(QUIZ_URL);

    await screen.findByText("Broke.");
    expect(headerButton()).toBeTruthy();
    expect(screen.queryByRole("button", { name: /about this question/ })).toBeNull();
  });

  it("is there for a visitor, who is asked to sign in", async () => {
    setup({ "GET /api/auth/me": () => errorResponse(401, "not_authenticated", "Sign in.") });
    renderApp(QUIZ_URL);

    await screen.findByText("Sign in to take the quiz");
    expect(headerButton()).toBeTruthy();
  });
});

describe("privacy", () => {
  /** A quiz whose option texts, option IDs and (once passed) explanations are all sentinels. */
  function sentinelQuiz() {
    const quiz = makeQuiz({ tag: `${OPTION_ID}-` });
    for (const question of quiz.questions) {
      for (const option of question.options) {
        option.text = option.id.endsWith("a") ? `${CORRECT}-${question.id}` : `${OPTION_TEXT}-${question.id}-${option.id.slice(-1)}`;
      }
    }
    return quiz;
  }

  const texts = (letter: string) => (n: number) => (letter === "a" ? `${CORRECT}-q${n}` : `${OPTION_TEXT}-q${n}-${letter}`);

  async function runCase(letter: "a" | "b") {
    vi.spyOn(console, "error").mockImplementation(() => {});
    installConsoleBuffer();
    let signedIn = false;
    const api = setup(
      {
        "GET /api/auth/me": () => (signedIn ? jsonResponse({ username: "ada_l" }) : errorResponse(401, "not_authenticated", "Sign in.")),
        "POST /api/auth/login": () => {
          signedIn = true;
          return jsonResponse({ username: "ada_l" });
        },
      },
      [sentinelQuiz()],
    );
    const { user } = renderApp(`/login?next=${QUIZ_URL}`);
    await user.type(await screen.findByLabelText("Username"), "ada_l");
    await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("group", { name: /^Question 1\b/ });
    await answerAll(user, letter, texts(letter));
    await submit(user);
    if (letter === "a") expect(document.body.textContent).toContain(EXPLANATION);

    document.cookie = `session=${COOKIE}`;
    console.error("something failed in the page");
    window.dispatchEvent(new ErrorEvent("error", { message: "Uncaught Error: a widget exploded" }));
    window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new Error("a promise was rejected") }));

    await user.click(questionButton(2));
    await writeAndSend(user, "Confusing explanation");
    await waitFor(() => expect(api.calls(FEEDBACK)).toHaveLength(1));
    return api.calls(FEEDBACK)[0];
  }

  it.each([
    ["a passed attempt", "a"],
    ["a failed attempt", "b"],
  ] as const)("puts no password, cookie, choice, answer, option ID or explanation in the request after %s", async (_name, letter) => {
    const call = await runCase(letter);

    // The request did carry the page context (this is what the test would catch a leak through).
    expect(bodyOf(call).context.question_id).toBe("q2");
    expect(bodyOf(call).context.console_errors).toEqual([
      "something failed in the page",
      "Uncaught Error: a widget exploded",
      "Error: a promise was rejected",
    ]);
    for (const sentinel of [PASSWORD, COOKIE, CORRECT, EXPLANATION, OPTION_ID, OPTION_TEXT]) {
      expect(call.text).not.toContain(sentinel);
      expect(JSON.stringify(call.headers)).not.toContain(sentinel);
    }
    // Its fields are the documented ones and nothing else.
    expect(Object.keys(bodyOf(call)).sort()).toEqual(["about_quiz_question", "category", "context", "message"]);
  });
});
