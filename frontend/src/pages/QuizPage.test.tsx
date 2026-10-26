import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { MemoryRouter, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NETWORK_ERROR_MESSAGE, UNEXPECTED_RESPONSE_MESSAGE } from "../api/apiError";
import App from "../App";
import { signInPath } from "../auth/paths";
import { apiRoutes, deferred, type RecordedCall } from "../test/apiRoutes";
import { errorResponse, htmlResponse, jsonResponse } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

const COURSE = "demo";
const CHAPTER = "c1";
const URL_OF_QUIZ = `/courses/${COURSE}/chapters/${CHAPTER}/quiz`;
const QUIZ = (course = COURSE, chapter = CHAPTER) => `GET /api/courses/${course}/chapters/${chapter}/quiz`;
const ATTEMPT = (course = COURSE, chapter = CHAPTER) => `POST /api/courses/${course}/chapters/${chapter}/quiz/attempts`;
const CHAPTERS = (course = COURSE) => `GET /api/courses/${course}/chapters`;

const CORRECT = "CORRECT-SENTINEL-7f3a";
const EXPLANATION = "EXPLANATION-SENTINEL-7f3a";
const OPTION_ID = "OPTID-SENTINEL-7f3a";

type Handler = NonNullable<Parameters<typeof apiRoutes>[0]>[string];

interface QuizOptions {
  /** Prefix of every option id. */
  tag?: string;
  /** The letters of the options, in the order the API sends them. */
  order?: string[];
  /** The text of the correct option (`a`) of question n. */
  correctText?: (n: number) => string;
  /** Extra keys the real API never sends, put on each question and option. */
  extras?: Record<string, unknown>;
}

/** A quiz like the API's: five questions, the first with a snippet; the correct option is `a`. */
function makeQuiz({ tag = "", order = ["c", "a", "b"], correctText = (n) => `Q${n} option a`, extras = {} }: QuizOptions = {}) {
  return {
    course_id: COURSE,
    chapter_id: CHAPTER,
    questions: [1, 2, 3, 4, 5].map((n) => ({
      id: `q${n}`,
      text: `Question text ${n}`,
      snippet: n === 1 ? { language: "python", code: "def f():\n    return 1\n" } : null,
      options: order.map((letter) => ({
        id: `${tag}${letter}`,
        text: letter === "a" ? correctText(n) : `Q${n} option ${letter}`,
        ...extras,
      })),
      ...extras,
    })),
    ...extras,
  };
}

const LESSON_OF = (questionId: string) => (questionId === "q1" || questionId === "q2" ? "l1" : "l2");

/** Grades a request like the server: the correct option ends in `a`, and 4 of 5 pass. */
function grade(call: RecordedCall, extras: Record<string, unknown> = {}, next: Record<string, unknown> = {}) {
  const answers = (call.body as { answers: { question_id: string; option_id: string }[] }).answers;
  const results = answers.map((a) => ({
    question_id: a.question_id,
    option_id: a.option_id,
    correct_option_id: a.option_id.endsWith("a") ? a.option_id : a.option_id.replace(/.$/, "a"),
    is_correct: a.option_id.endsWith("a"),
    explanation: `${EXPLANATION}-${a.question_id}`,
    lesson_id: LESSON_OF(a.question_id),
  }));
  const score = results.filter((r) => r.is_correct).length;
  const base = { course_id: COURSE, chapter_id: CHAPTER, score, total: 5 };
  if (score >= 4) {
    return { ...base, passed: true, results, next_chapter_id: "c2", course_complete: false, ...next, ...extras };
  }
  const wrong = results.filter((r) => !r.is_correct).map((r) => ({ question_id: r.question_id, lesson_id: r.lesson_id }));
  return { ...base, passed: false, wrong, ...extras };
}

const chapterList = (status: string | null = "in_progress", chapters: unknown[] | null = null) => ({
  course_id: COURSE,
  chapters: chapters ?? [
    {
      id: "c1",
      title: "Chapter one",
      free_preview: true,
      status,
      lessons: [
        { id: "l1", title: "First lesson" },
        { id: "l2", title: "Second lesson" },
      ],
    },
    { id: "c2", title: "Chapter two", free_preview: false, status: "locked", lessons: [{ id: "l3", title: "Third lesson" }] },
    { id: "c3", title: "Chapter three", free_preview: false, status: "locked", lessons: [] },
  ],
});

interface SetupOptions {
  learner?: boolean;
  /** The answers of the quiz `GET`, in turn; the last one repeats. */
  quizzes?: unknown[];
  status?: string | null;
  chapters?: unknown[] | null;
  attempt?: Handler;
  course?: string;
  chapter?: string;
  extra?: Record<string, Handler>;
}

function setup(options: SetupOptions = {}) {
  const course = options.course ?? COURSE;
  const chapter = options.chapter ?? CHAPTER;
  const quizzes = options.quizzes ?? [makeQuiz()];
  let asked = 0;
  return apiRoutes({
    ...(options.learner !== false && { "GET /api/auth/me": () => jsonResponse({ username: "ada_l" }) }),
    [QUIZ(course, chapter)]: () => jsonResponse(quizzes[Math.min(asked++, quizzes.length - 1)]),
    [`GET /api/courses/${course}/progress`]: () => jsonResponse({ course_id: course, course_complete: false, chapters: [] }),
    [CHAPTERS(course)]: () => jsonResponse(chapterList(options.status === undefined ? "in_progress" : options.status, options.chapters ?? null)),
    [ATTEMPT(course, chapter)]: options.attempt ?? ((call) => jsonResponse(grade(call))),
    ...options.extra,
  });
}

const group = (n: number) => screen.getByRole("group", { name: new RegExp(`^Question ${n}\\b`) });
const h1 = () => screen.getByRole("heading", { level: 1 });
const h2 = () => screen.getByRole("heading", { level: 2 });
const submitButton = () => screen.getByRole("button", { name: /^Submit answers$|^Submitting…$/ });
const href = (element: HTMLElement) => element.getAttribute("href");

/** Picks the option with this text in question n. */
async function pick(user: UserEvent, n: number, optionText: string) {
  await user.click(within(group(n)).getByRole("radio", { name: optionText }));
}

/** Answers every question; `wrongFrom` makes questions from that number on get a wrong answer. */
async function answerAll(user: UserEvent, wrongFrom = 99) {
  for (let n = 1; n <= 5; n++) {
    await pick(user, n, n >= wrongFrom ? `Q${n} option b` : label(n));
  }
}

/** The text of the correct option, as the test quiz has it. */
let correctLabel: (n: number) => string = (n) => `Q${n} option a`;
const label = (n: number) => correctLabel(n);
afterEach(() => {
  correctLabel = (n) => `Q${n} option a`;
});

async function loaded(url = URL_OF_QUIZ, options?: { strict?: boolean }) {
  const view = renderApp(url, options);
  await screen.findByRole("group", { name: /^Question 1\b/ });
  return view;
}

describe("requests", () => {
  it("sends the quiz and chapters requests for the course and chapter in the URL, and no other", async () => {
    const api = setup({ course: "other-course", chapter: "ch-9", status: "in_progress", chapters: [] });
    api.fetchMock.mockClear();
    renderApp("/courses/other-course/chapters/ch-9/quiz");
    await screen.findByRole("heading", { level: 1, name: "Quiz not found" });

    const calls = api.calls().filter((call) => !call.path.startsWith("/api/auth/"));
    expect(calls.map((call) => `${call.method} ${call.path}`).sort()).toEqual(
      ["GET /api/courses/other-course/chapters", "GET /api/courses/other-course/chapters/ch-9/quiz"].sort(),
    );
  });

  it("asks nothing until the auth state is known", async () => {
    const me = deferred<Response>();
    const api = setup({ extra: { "GET /api/auth/me": () => me.promise } });
    renderApp(URL_OF_QUIZ);

    expect(screen.getByRole("status").textContent).toBe("Loading…");
    expect(h1().textContent).toBe("Quiz");
    await waitFor(() => expect(api.calls("GET /api/auth/me")).toHaveLength(1));
    expect(api.calls(QUIZ())).toHaveLength(0);
    expect(api.calls(CHAPTERS())).toHaveLength(0);

    me.resolve(jsonResponse({ username: "ada_l" }));
    expect(await screen.findByRole("group", { name: /^Question 1\b/ })).toBeTruthy();
    expect(api.calls(QUIZ())).toHaveLength(1);
    expect(api.calls(CHAPTERS())).toHaveLength(1);
  });

  it("asks for nothing for a visitor", async () => {
    const api = setup({ learner: false });
    renderApp(URL_OF_QUIZ);

    expect(await screen.findByText("Sign in to take the quiz")).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(api.calls(QUIZ())).toHaveLength(0);
    expect(api.calls(CHAPTERS())).toHaveLength(0);
    expect(api.calls().map((call) => call.path)).toEqual(["/api/auth/me"]);
  });

  it("encodes the ids from the URL", async () => {
    const api = apiRoutes({
      "GET /api/auth/me": () => jsonResponse({ username: "ada_l" }),
      "GET /api/courses/my%20course/chapters/c%2F1/quiz": () => jsonResponse(makeQuiz()),
      "GET /api/courses/my%20course/chapters": () => jsonResponse(chapterList("in_progress", [{ id: "c/1", title: "Odd", free_preview: false, status: "in_progress", lessons: [] }])),
    });
    renderApp("/courses/my%20course/chapters/c%2F1/quiz");
    expect(await screen.findByRole("heading", { level: 1, name: "Quiz: Odd" })).toBeTruthy();
    expect(api.calls("GET /api/courses/my%20course/chapters/c%2F1/quiz")).toHaveLength(1);
  });
});

describe("loading and the title", () => {
  it("shows Quiz, Quiz – Courses and Loading… while it loads", async () => {
    const pending = deferred<Response>();
    setup({ extra: { [QUIZ()]: () => pending.promise } });
    renderApp(URL_OF_QUIZ);

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Loading…"));
    expect(h1().textContent).toBe("Quiz");
    expect(document.title).toBe("Quiz – Courses");
    pending.resolve(jsonResponse(makeQuiz()));
    expect(await screen.findByRole("group", { name: /^Question 1\b/ })).toBeTruthy();
  });

  it("shows Quiz: <chapter title> as the h1 and the document title", async () => {
    setup();
    await loaded();

    expect(h1().textContent).toBe("Quiz: Chapter one");
    expect(document.title).toBe("Quiz: Chapter one – Courses");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("taking the quiz", () => {
  it("says how many questions there are, the pass mark, and that retakes are free", async () => {
    setup();
    await loaded();
    expect(
      screen.getByText("Answer all 5 questions. You need 4 to pass, and you can retake the quiz as often as you like."),
    ).toBeTruthy();
  });

  it("lists the questions in an ordered list, in the order sent, each a fieldset with its number in the legend", async () => {
    setup();
    await loaded();

    const list = screen.getByRole("list");
    expect(list.tagName).toBe("OL");
    const groups = within(list).getAllByRole("group");
    expect(groups).toHaveLength(5);
    groups.forEach((g, index) => {
      expect(g.tagName).toBe("FIELDSET");
      expect(g.querySelector("legend")?.textContent).toBe(`Question ${index + 1} Question text ${index + 1}`);
    });
    expect(group(1)).toBe(groups[0]);
  });

  it("shows the options in the order sent, never sorted, as unselected radios with visible labels", async () => {
    setup();
    await loaded();

    const radios = within(group(2)).getAllByRole("radio");
    expect(radios.map((radio) => radio.closest("label")?.textContent)).toEqual(["Q2 option c", "Q2 option a", "Q2 option b"]);
    expect(screen.getAllByRole("radio")).toHaveLength(15);
    for (const radio of screen.getAllByRole("radio") as HTMLInputElement[]) {
      expect(radio.type).toBe("radio");
      expect(radio.checked).toBe(false);
    }
  });

  it("gives the radios of a question one name, and each question its own", async () => {
    setup();
    await loaded();

    const names = [1, 2, 3, 4, 5].map((n) => {
      const inGroup = (within(group(n)).getAllByRole("radio") as HTMLInputElement[]).map((radio) => radio.name);
      expect(new Set(inGroup).size).toBe(1);
      return inGroup[0];
    });
    expect(new Set(names).size).toBe(5);
  });

  it("works with the keyboard: Tab enters a group, the arrow keys move inside it, Space selects", async () => {
    // jsdom has no CSS.escape, which user-event needs to find the other radios of a group.
    vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) });
    setup();
    const { user } = await loaded();

    // From the h1, Tab reaches the snippet box of question 1 first, then its first radio.
    await user.click(h1());
    await user.tab();
    const snippet = screen.getByRole("region", { name: "Code for question 1" });
    expect(document.activeElement).toBe(snippet);
    await user.tab();
    const first = within(group(1)).getAllByRole("radio")[0] as HTMLInputElement;
    expect(document.activeElement).toBe(first);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(within(group(1)).getAllByRole("radio")[1]);
    await user.keyboard(" ");
    expect((within(group(1)).getAllByRole("radio")[1] as HTMLInputElement).checked).toBe(true);
    expect((within(group(1)).getAllByRole("radio")[0] as HTMLInputElement).checked).toBe(false);
    // Tab leaves the group; the arrow keys stay inside it.
    await user.tab();
    expect(group(2).contains(document.activeElement)).toBe(true);
  });

  it("shows a backtick span in a question and in an option as code, and nothing else as markup", async () => {
    const quiz = makeQuiz();
    quiz.questions[1].text = "Use `@mcp.tool()` here";
    quiz.questions[1].options[0].text = "Call `run()` first";
    quiz.questions[2].text = "a ` b";
    quiz.questions[2].options[0].text = "``";
    quiz.questions[3].text = "'<img src=x onerror=alert(1)>' **bold** &amp;";
    quiz.questions[3].options[0].text = "<script>alert(1)</script>";
    setup({ quizzes: [quiz] });
    await loaded();

    const legend2 = group(2).querySelector("legend")!;
    expect(legend2.querySelectorAll("code")).toHaveLength(1);
    expect(legend2.querySelector("code")?.textContent).toBe("@mcp.tool()");
    expect(within(group(2)).getByRole("radio", { name: "Call run() first" }).closest("label")?.querySelector("code")?.textContent).toBe("run()");
    expect(group(3).querySelector("legend")?.textContent).toBe("Question 3 a ` b");
    expect(group(3).querySelector("code")).toBeNull();
    expect(within(group(3)).getAllByRole("radio")[0].closest("label")?.textContent).toBe("``");
    expect(group(4).querySelector("legend")?.textContent).toBe("Question 4 '<img src=x onerror=alert(1)>' **bold** &amp;");
    expect(group(4).querySelector("img, strong, b, script")).toBeNull();
    expect(document.querySelector("main img, main script, main strong")).toBeNull();
  });

  it("shows a snippet as plain text in pre > code, keeping its whitespace, and none for a question without one", async () => {
    const code = "def f():\n    return '</code></pre><script>alert(1)</script>'\n\n\tx = 1  \n";
    const quiz = makeQuiz();
    quiz.questions[0].snippet = { language: "python", code };
    setup({ quizzes: [quiz] });
    await loaded();

    const pre = group(1).querySelector("pre")!;
    expect(pre.querySelector(":scope > code")?.textContent).toBe(code);
    expect(pre.children).toHaveLength(1);
    expect(pre.querySelector("code")?.children).toHaveLength(0);
    expect(document.querySelector("main script")).toBeNull();
    expect(pre.tabIndex).toBe(0);
    expect(pre.getAttribute("aria-label")).toBe("Code for question 1");
    for (let n = 2; n <= 5; n++) expect(group(n).querySelector("pre")).toBeNull();
    expect(document.querySelectorAll("main pre")).toHaveLength(1);
  });

  it("shows N of 5 answered, and Submit answers stays disabled until every question has an answer", async () => {
    setup();
    const { user } = await loaded();
    const counter = () => screen.getByText(/ of 5 answered$/);

    expect(counter().textContent).toBe("0 of 5 answered");
    expect(submitButton().hasAttribute("disabled")).toBe(true);
    expect(submitButton().getAttribute("aria-describedby")).toBe(counter().id);

    await pick(user, 1, "Q1 option a");
    await pick(user, 2, "Q2 option b");
    expect(counter().textContent).toBe("2 of 5 answered");
    // Changing an answer does not change the count.
    await pick(user, 2, "Q2 option c");
    expect(counter().textContent).toBe("2 of 5 answered");
    await pick(user, 3, "Q3 option a");
    await pick(user, 4, "Q4 option a");
    expect(submitButton().hasAttribute("disabled")).toBe(true);
    await pick(user, 5, "Q5 option a");
    expect(counter().textContent).toBe("5 of 5 answered");
    expect(submitButton().hasAttribute("disabled")).toBe(false);
  });

  it("uses the number of questions in the response as the total", async () => {
    const quiz = makeQuiz();
    quiz.questions = quiz.questions.slice(0, 3);
    setup({ quizzes: [quiz] });
    const { user } = await loaded();

    expect(screen.getByText("0 of 3 answered")).toBeTruthy();
    for (let n = 1; n <= 3; n++) await pick(user, n, `Q${n} option a`);
    expect(submitButton().hasAttribute("disabled")).toBe(false);
  });

  it("sends nothing when Enter is pressed in a group before every question is answered", async () => {
    const api = setup();
    const { user } = await loaded();
    await pick(user, 1, "Q1 option a");

    await user.keyboard("{Enter}");
    fireEvent.submit(document.querySelector("form")!);
    await act(async () => {});

    expect(api.calls(ATTEMPT())).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(15);
  });

  it("sends the answers as one POST: one entry per question, in quiz order, with the ids on screen and no other key", async () => {
    const api = setup();
    const { user } = await loaded();
    await pick(user, 1, "Q1 option c");
    await pick(user, 2, "Q2 option a");
    await pick(user, 3, "Q3 option b");
    await pick(user, 4, "Q4 option c");
    await pick(user, 5, "Q5 option a");
    await user.click(submitButton());
    await screen.findByRole("heading", { level: 2 });

    expect(api.calls(ATTEMPT())).toHaveLength(1);
    expect(api.calls(ATTEMPT())[0].body).toEqual({
      answers: [
        { question_id: "q1", option_id: "c" },
        { question_id: "q2", option_id: "a" },
        { question_id: "q3", option_id: "b" },
        { question_id: "q4", option_id: "c" },
        { question_id: "q5", option_id: "a" },
      ],
    });
    expect(Object.keys(api.calls(ATTEMPT())[0].body as object)).toEqual(["answers"]);
  });

  it("while submitting disables the button, relabels it, disables the fieldsets, and sends one POST for a double click", async () => {
    const slow = deferred<Response>();
    const api = setup({ attempt: () => slow.promise });
    const { user } = await loaded();
    await answerAll(user);

    await user.dblClick(submitButton());

    await waitFor(() => expect(submitButton().textContent).toBe("Submitting…"));
    expect(submitButton().hasAttribute("disabled")).toBe(true);
    for (let n = 1; n <= 5; n++) expect((group(n) as HTMLFieldSetElement).disabled).toBe(true);
    expect(api.calls(ATTEMPT())).toHaveLength(1);
    slow.resolve(jsonResponse(grade(api.calls(ATTEMPT())[0])));
    await screen.findByRole("heading", { level: 2 });
    expect(api.calls(ATTEMPT())).toHaveLength(1);
  });

  it("sends one POST when the form is submitted twice in the same tick", async () => {
    const slow = deferred<Response>();
    const api = setup({ attempt: () => slow.promise });
    const { user } = await loaded();
    await answerAll(user);

    const form = document.querySelector("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(api.calls(ATTEMPT())).toHaveLength(1));
    await act(async () => {});
    expect(api.calls(ATTEMPT())).toHaveLength(1);
    slow.resolve(jsonResponse(grade(api.calls(ATTEMPT())[0])));
    await screen.findByRole("heading", { level: 2 });
  });

  it("shows two options with the same text and tells them apart by the radio that is selected", async () => {
    const quiz = makeQuiz();
    quiz.questions[1].options = [
      { id: "x", text: "Same" },
      { id: "y", text: "Same" },
      { id: "z", text: "Other" },
    ];
    const api = setup({ quizzes: [quiz] });
    const { user } = await loaded();

    const same = within(group(2)).getAllByRole("radio", { name: "Same" }) as HTMLInputElement[];
    expect(same).toHaveLength(2);
    await user.click(same[1]);
    expect(same.map((radio) => radio.checked)).toEqual([false, true]);
    await pick(user, 1, "Q1 option a");
    await pick(user, 3, "Q3 option a");
    await pick(user, 4, "Q4 option a");
    await pick(user, 5, "Q5 option a");
    await user.click(submitButton());
    await waitFor(() => expect(api.calls(ATTEMPT())).toHaveLength(1));
    expect((api.calls(ATTEMPT())[0].body as { answers: { option_id: string }[] }).answers[1].option_id).toBe("y");
  });

  it("shows only what it reads of a quiz: extra keys the API never sends do not reach the DOM", async () => {
    setup({
      quizzes: [
        makeQuiz({
          extras: { correct: `${CORRECT}-extra`, explanation: `${EXPLANATION}-extra`, lesson: `LESSON-SENTINEL-7f3a`, correct_option_id: `${CORRECT}-key` },
        }),
      ],
    });
    await loaded();

    const html = document.body.innerHTML;
    for (const sentinel of [CORRECT, EXPLANATION, "LESSON-SENTINEL-7f3a"]) expect(html).not.toContain(sentinel);
  });

  it("never shows an option id, and puts no choice or id in title, aria-label, data-* or a class", async () => {
    setup({ quizzes: [makeQuiz({ tag: `${OPTION_ID}-` })] });
    const { user } = await loaded();
    await answerAll(user);

    expect(document.body.textContent).not.toContain(OPTION_ID);
    expect(document.body.innerHTML).not.toContain(OPTION_ID);
    for (const element of document.querySelectorAll("main *")) {
      expect(element.hasAttribute("title")).toBe(false);
      expect([...element.attributes].some((a) => a.name.startsWith("data-"))).toBe(false);
      expect(element.className.toString()).not.toMatch(/q[1-5]|option [abc]/i);
    }
    for (const el of document.querySelectorAll("main [aria-label]")) expect(el.getAttribute("aria-label")).toMatch(/^(Quiz|Code for question \d)$/);
  });
});

describe("a failed attempt", () => {
  async function fail() {
    const view = await loaded();
    await answerAll(view.user, 4);
    await view.user.click(submitButton());
    await screen.findByRole("heading", { level: 2 });
    return view;
  }

  it("replaces the form with a read-only review, shows the score and need, and focuses the heading", async () => {
    setup();
    await fail();

    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Submit answers" })).toBeNull();
    expect(h2().textContent).toBe("You scored 3/5. You need 4 to pass.");
    await waitFor(() => expect(document.activeElement).toBe(h2()));
  });

  it("uses score and total from the response", async () => {
    setup({ attempt: (call) => jsonResponse({ ...grade(call), score: 2, total: 7 }) });
    await fail();
    expect(h2().textContent).toBe("You scored 2/7. You need 4 to pass.");
  });

  it("lists every question in order; wrong ones say Incorrect with the learner's answer and a lesson link, right ones say Correct with no link", async () => {
    setup();
    await fail();

    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(5);
    items.forEach((item, index) => expect(item.textContent).toContain(`Question ${index + 1} Question text ${index + 1}`));
    for (const index of [0, 1, 2]) {
      const item = within(items[index]);
      expect(item.getByText("Correct")).toBeTruthy();
      expect(item.queryByText("Incorrect")).toBeNull();
      expect(item.getByText(`Your answer: Q${index + 1} option a`)).toBeTruthy();
      expect(item.queryByRole("link")).toBeNull();
    }
    for (const index of [3, 4]) {
      const item = within(items[index]);
      expect(item.getByText("Incorrect")).toBeTruthy();
      expect(item.queryByText("Correct")).toBeNull();
      expect(item.getByText(`Your answer: Q${index + 1} option b`)).toBeTruthy();
      const link = item.getByRole("link", { name: "Review: Second lesson" });
      expect(href(link)).toBe("/courses/demo/lessons/l2");
    }
  });

  it("encodes the course and lesson ids in the review link", async () => {
    const api = apiRoutes({
      "GET /api/auth/me": () => jsonResponse({ username: "ada_l" }),
      "GET /api/courses/my%20course/chapters/c1/quiz": () => jsonResponse(makeQuiz()),
      "GET /api/courses/my%20course/chapters": () =>
        jsonResponse(chapterList("in_progress", [{ id: "c1", title: "T", free_preview: false, status: "in_progress", lessons: [{ id: "l/2", title: "Odd" }] }])),
      "POST /api/courses/my%20course/chapters/c1/quiz/attempts": () =>
        jsonResponse({ course_id: "x", chapter_id: "c1", passed: false, score: 0, total: 5, wrong: [{ question_id: "q1", lesson_id: "l/2" }] }),
    });
    renderApp("/courses/my%20course/chapters/c1/quiz");
    await screen.findByRole("group", { name: /^Question 1\b/ });
    const user = userEvent.setup();
    for (let n = 1; n <= 5; n++) await pick(user, n, `Q${n} option b`);
    await user.click(submitButton());
    const link = await screen.findByRole("link", { name: "Review: Odd" });
    expect(href(link)).toBe("/courses/my%20course/lessons/l%2F2");
    expect(api.calls("POST /api/courses/my%20course/chapters/c1/quiz/attempts")).toHaveLength(1);
  });

  it("links a lesson that is not in the chapters list to the course, and gives two links for two questions with one lesson", async () => {
    setup({
      attempt: () =>
        jsonResponse({
          course_id: COURSE,
          chapter_id: CHAPTER,
          passed: false,
          score: 2,
          total: 5,
          wrong: [
            { question_id: "q1", lesson_id: "gone" },
            { question_id: "q2", lesson_id: "l1" },
            { question_id: "q3", lesson_id: "l1" },
          ],
        }),
    });
    await fail();

    expect(href(screen.getByRole("link", { name: "Review the chapter's lessons" }))).toBe("/courses/demo");
    const same = screen.getAllByRole("link", { name: "Review: First lesson" });
    expect(same).toHaveLength(2);
    expect(same.map(href)).toEqual(["/courses/demo/lessons/l1", "/courses/demo/lessons/l1"]);
  });

  it("shows nothing that points at a right answer: the sentinel for the correct option and the explanation are absent", async () => {
    correctLabel = (n) => (n >= 4 ? `${CORRECT}-${n}` : `Q${n} option a`);
    setup({ quizzes: [makeQuiz({ correctText: correctLabel })] });
    await fail();

    expect(h2().textContent).toBe("You scored 3/5. You need 4 to pass.");
    const html = document.body.innerHTML;
    expect(html).not.toContain(CORRECT);
    expect(html).not.toContain(EXPLANATION);
    // Of the options of a wrong question, only the learner's own is in the DOM.
    expect(document.body.textContent).not.toContain("Q4 option c");
    expect(document.body.textContent).not.toContain("Q5 option c");
    expect(document.body.textContent).toContain("Q4 option b");
  });

  it("reads only score, total, passed and wrong: extra keys the API never sends do not reach the DOM", async () => {
    correctLabel = (n) => (n >= 4 ? `${CORRECT}-${n}` : `Q${n} option a`);
    setup({
      quizzes: [makeQuiz({ correctText: correctLabel })],
      attempt: (call) =>
        jsonResponse(
          grade(call, {
            correct_option_id: `${CORRECT}-id`,
            explanation: `${EXPLANATION}-top`,
            results: [{ question_id: "q4", correct_option_id: `${CORRECT}-r`, explanation: `${EXPLANATION}-r`, is_correct: false, option_id: "b" }],
            correct: `${CORRECT}-flag`,
            wrong: [
              { question_id: "q4", lesson_id: "l2", correct_option_id: `${CORRECT}-w`, explanation: `${EXPLANATION}-w`, correct: `${CORRECT}-wc` },
              { question_id: "q5", lesson_id: "l2" },
            ],
          }),
        ),
    });
    await fail();

    const html = document.body.innerHTML;
    expect(h2().textContent).toBe("You scored 3/5. You need 4 to pass.");
    expect(html).not.toContain(CORRECT);
    expect(html).not.toContain(EXPLANATION);
    expect(within(screen.getAllByRole("listitem")[3]).getByText("Incorrect")).toBeTruthy();
  });

  it("says the chapter is already passed when it was passed on load, and not otherwise", async () => {
    setup({ status: "passed" });
    await fail();
    expect(screen.getByText("You have already passed this chapter. This score does not change that.")).toBeTruthy();
    cleanup();

    setup({ status: "in_progress" });
    await fail();
    expect(screen.queryByText(/already passed/)).toBeNull();
  });

  it("Try again fetches only the quiz, shows Loading… with no answers in the DOM, then a new form with nothing selected and focus on question 1", async () => {
    const second = deferred<Response>();
    let quizCalls = 0;
    const api = setup({
      quizzes: [makeQuiz()],
      extra: {
        [QUIZ()]: () => {
          quizCalls += 1;
          return quizCalls === 1 ? jsonResponse(makeQuiz()) : second.promise;
        },
      },
    });
    const { user } = await fail();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(screen.getByRole("status").textContent).toBe("Loading…");
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(document.body.textContent).not.toContain("Your answer");
    expect(document.body.textContent).not.toContain("Q4 option b");
    expect(api.calls(QUIZ())).toHaveLength(2);
    expect(api.calls(CHAPTERS())).toHaveLength(1);

    second.resolve(jsonResponse(makeQuiz({ order: ["b", "c", "a"], tag: "n2-" })));
    await screen.findByRole("group", { name: /^Question 1\b/ });
    expect(within(group(3)).getAllByRole("radio").map((r) => r.closest("label")?.textContent)).toEqual([
      "Q3 option b",
      "Q3 option c",
      "Q3 option a",
    ]);
    for (const radio of screen.getAllByRole("radio") as HTMLInputElement[]) expect(radio.checked).toBe(false);
    expect(screen.getByText("0 of 5 answered")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(group(1)));
    expect(api.calls(CHAPTERS())).toHaveLength(1);
  });

  it("sends the second quiz's ids after Try again", async () => {
    const api = setup({ quizzes: [makeQuiz(), makeQuiz({ order: ["b", "c", "a"], tag: "n2-" })] });
    const { user } = await fail();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("group", { name: /^Question 1\b/ });
    await answerAll(user);
    await user.click(submitButton());
    await screen.findByRole("heading", { level: 2 });

    expect(api.calls(ATTEMPT())).toHaveLength(2);
    expect(api.calls(ATTEMPT())[1].body).toEqual({
      answers: [1, 2, 3, 4, 5].map((n) => ({ question_id: `q${n}`, option_id: "n2-a" })),
    });
  });
});

describe("a passed attempt", () => {
  async function pass(wrongFrom = 99) {
    const view = await loaded();
    await answerAll(view.user, wrongFrom);
    await view.user.click(submitButton());
    await screen.findByRole("heading", { level: 2 });
    return view;
  }
  const sentinelText = (n: number) => `${CORRECT}-${n}`;

  it("shows You passed with N/5., replaces the form, and focuses the heading", async () => {
    setup();
    await pass();

    expect(h2().textContent).toBe("You passed with 5/5.");
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(h2()));
  });

  it("shows every correct answer and explanation, in quiz order, even when the learner's answer was right", async () => {
    correctLabel = sentinelText;
    setup({ quizzes: [makeQuiz({ correctText: sentinelText })] });
    await pass();

    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(5);
    items.forEach((item, index) => {
      const n = index + 1;
      const view = within(item);
      expect(item.textContent).toContain(`Question ${n} Question text ${n}`);
      expect(view.getByText("Correct")).toBeTruthy();
      expect(view.getByText(`Your answer: ${CORRECT}-${n}`)).toBeTruthy();
      expect(view.getByText(`Correct answer: ${CORRECT}-${n}`)).toBeTruthy();
      expect(view.getByText(`Explanation: ${EXPLANATION}-q${n}`)).toBeTruthy();
    });
  });

  it("with a score of 4 shows one Incorrect question with its correct answer and explanation", async () => {
    setup();
    await pass(5);

    expect(h2().textContent).toBe("You passed with 4/5.");
    expect(screen.getAllByText("Incorrect")).toHaveLength(1);
    expect(screen.getAllByText("Correct")).toHaveLength(4);
    const item = within(screen.getAllByRole("listitem")[4]);
    expect(item.getByText("Incorrect")).toBeTruthy();
    expect(item.getByText("Your answer: Q5 option b")).toBeTruthy();
    expect(item.getByText("Correct answer: Q5 option a")).toBeTruthy();
    expect(item.getByText(`Explanation: ${EXPLANATION}-q5`)).toBeTruthy();
  });

  it("shows backtick spans in the explanation and the correct answer as inline code", async () => {
    setup({
      quizzes: [makeQuiz({ correctText: (n) => (n === 1 ? "Use `@mcp.tool()`" : `Q${n} option a`) })],
      attempt: (call) => {
        const body = grade(call) as { results: { explanation: string; question_id: string }[] };
        body.results[0].explanation = "Because `x` <b>y</b>";
        return jsonResponse(body);
      },
    });
    correctLabel = (n) => (n === 1 ? "Use @mcp.tool()" : `Q${n} option a`);
    await pass();

    const item = screen.getAllByRole("listitem")[0];
    expect([...item.querySelectorAll("code")].map((c) => c.textContent)).toEqual(["@mcp.tool()", "@mcp.tool()", "x"]);
    expect(item.textContent).toContain("Explanation: Because x <b>y</b>");
    expect(item.querySelector("b")).toBeNull();
  });

  it("finds option text by id in the quiz that was submitted, so changing ids on every request is fine", async () => {
    const api = setup({ quizzes: [makeQuiz({ tag: "first-" }), makeQuiz({ tag: "second-", order: ["b", "a", "c"] })] });
    const { user } = await loaded();
    await answerAll(user);
    await user.click(submitButton());
    await screen.findByRole("heading", { level: 2 });

    expect(api.calls(ATTEMPT())[0].body).toEqual({ answers: [1, 2, 3, 4, 5].map((n) => ({ question_id: `q${n}`, option_id: "first-a" })) });
    expect(screen.getAllByText(/^Correct answer: Q\d option a$/)).toHaveLength(5);
    expect(document.body.textContent).not.toContain("first-");
  });

  it("skips a result whose ids match nothing in the quiz, shows no raw id, and still shows the heading and the way on", async () => {
    setup({
      attempt: (call) => {
        const body = grade(call) as { results: Record<string, unknown>[] };
        body.results[0].option_id = "RAW-ID-SENTINEL-1";
        body.results[1].correct_option_id = "RAW-ID-SENTINEL-2";
        body.results.push({ ...body.results[2], question_id: "RAW-ID-SENTINEL-3" });
        return jsonResponse(body);
      },
    });
    await pass();

    expect(h2().textContent).toBe("You passed with 5/5.");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(document.body.innerHTML).not.toContain("RAW-ID-SENTINEL");
    expect(screen.getByRole("link", { name: "Start the next chapter" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retake the quiz" })).toBeTruthy();
  });

  it("links Start the next chapter to the first lesson of the next chapter", async () => {
    setup();
    await pass();
    expect(href(screen.getByRole("link", { name: "Start the next chapter" }))).toBe("/courses/demo/lessons/l3");
    expect(screen.queryByRole("link", { name: "Back to course" })).toBeNull();
  });

  it.each([
    ["is not in the chapters list", "c9"],
    ["has no lessons", "c3"],
  ])("links Back to course when the next chapter %s", async (_name, next) => {
    setup({ attempt: (call) => jsonResponse(grade(call, {}, { next_chapter_id: next })) });
    await pass();
    expect(screen.queryByRole("link", { name: "Start the next chapter" })).toBeNull();
    expect(href(screen.getByRole("link", { name: "Back to course" }))).toBe("/courses/demo");
  });

  it("says the course is complete, with Back to course", async () => {
    setup({ attempt: (call) => jsonResponse(grade(call, {}, { next_chapter_id: null, course_complete: true })) });
    await pass();

    expect(screen.getByText("You've completed the course")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Back to course" })).toHaveLength(1);
    expect(href(screen.getByRole("link", { name: "Back to course" }))).toBe("/courses/demo");
    expect(screen.queryByRole("link", { name: "Start the next chapter" })).toBeNull();
  });

  it("shows only Back to course when there is no next chapter and the course is not complete", async () => {
    setup({ attempt: (call) => jsonResponse(grade(call, {}, { next_chapter_id: null, course_complete: false })) });
    await pass();

    expect(screen.queryByText("You've completed the course")).toBeNull();
    expect(screen.getAllByRole("link").filter((l) => !l.closest("header") && !l.closest(".skip-link")).map((l) => l.textContent)).toContain("Back to course");
    expect(screen.queryByRole("link", { name: "Start the next chapter" })).toBeNull();
  });

  it("Retake the quiz drops the key and explanations at once, fetches a new quiz and shows an empty form", async () => {
    correctLabel = sentinelText;
    const second = deferred<Response>();
    let quizCalls = 0;
    const api = setup({
      extra: {
        [QUIZ()]: () => {
          quizCalls += 1;
          return quizCalls === 1 ? jsonResponse(makeQuiz({ correctText: sentinelText })) : second.promise;
        },
      },
    });
    const { user } = await pass();
    expect(document.body.innerHTML).toContain(EXPLANATION);

    await user.click(screen.getByRole("button", { name: "Retake the quiz" }));

    expect(screen.getByRole("status").textContent).toBe("Loading…");
    expect(document.body.innerHTML).not.toContain(EXPLANATION);
    expect(document.body.innerHTML).not.toContain(CORRECT);
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(api.calls(QUIZ())).toHaveLength(2);
    expect(api.calls(CHAPTERS())).toHaveLength(1);

    second.resolve(jsonResponse(makeQuiz({ order: ["a", "b", "c"], tag: "n2-" })));
    await screen.findByRole("group", { name: /^Question 1\b/ });
    for (const radio of screen.getAllByRole("radio") as HTMLInputElement[]) expect(radio.checked).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(group(1)));
  });

  it("pass, retake, fail: the failed review shows nothing from the earlier pass, and says the chapter is passed", async () => {
    correctLabel = sentinelText;
    setup({ quizzes: [makeQuiz({ correctText: sentinelText }), makeQuiz({ correctText: sentinelText, tag: "n2-" })], status: "in_progress" });
    const { user } = await pass();
    await user.click(screen.getByRole("button", { name: "Retake the quiz" }));
    await screen.findByRole("group", { name: /^Question 1\b/ });
    for (let n = 1; n <= 5; n++) await pick(user, n, `Q${n} option b`);
    await user.click(submitButton());
    await screen.findByRole("heading", { level: 2, name: "You scored 0/5. You need 4 to pass." });

    expect(document.body.innerHTML).not.toContain(EXPLANATION);
    expect(document.body.innerHTML).not.toContain(CORRECT);
    expect(screen.getByText("You have already passed this chapter. This score does not change that.")).toBeTruthy();
  });
});

describe("access", () => {
  it("shows a visitor the h1 Quiz, Sign in to take the quiz, and a sign-in link back to this page", async () => {
    setup({ learner: false });
    renderApp(`${URL_OF_QUIZ}?x=1`);

    expect(await screen.findByText("Sign in to take the quiz")).toBeTruthy();
    expect(h1().textContent).toBe("Quiz");
    const link = screen.getAllByRole("link", { name: "Sign in" }).find((l) => !l.closest("header"))!;
    expect(href(link)).toBe(signInPath(`${URL_OF_QUIZ}?x=1`));
    expect(document.title).toBe("Quiz – Courses");
  });

  it("turns into the visitor view when the session ends on submit, with the answers gone", async () => {
    setup({ attempt: () => errorResponse(401, "not_authenticated", "Sign in to continue.") });
    const { user } = await loaded();
    await answerAll(user);
    await user.click(submitButton());

    expect(await screen.findByText("Sign in to take the quiz")).toBeTruthy();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.queryByRole("group")).toBeNull();
    expect(h1().textContent).toBe("Quiz");
    expect(screen.getByRole("navigation", { name: "Account" }).textContent).toContain("Sign in");
  });

  it("turns into the visitor view when the session ends while a review is shown and the learner retakes", async () => {
    let asked = 0;
    setup({
      extra: {
        [QUIZ()]: () => {
          asked += 1;
          return asked === 1 ? jsonResponse(makeQuiz({ correctText: (n) => `${CORRECT}-${n}` })) : errorResponse(401, "not_authenticated", "Sign in to continue.");
        },
      },
    });
    correctLabel = (n) => `${CORRECT}-${n}`;
    const { user } = await loaded();
    await answerAll(user);
    await user.click(submitButton());
    await screen.findByRole("heading", { level: 2 });
    await user.click(screen.getByRole("button", { name: "Retake the quiz" }));

    expect(await screen.findByText("Sign in to take the quiz")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(EXPLANATION);
    expect(document.body.innerHTML).not.toContain(CORRECT);
  });

  it("shows the visitor view when the quiz request itself answers 401", async () => {
    setup({ extra: { [QUIZ()]: () => errorResponse(401, "not_authenticated", "Sign in to continue.") } });
    renderApp(URL_OF_QUIZ);
    expect(await screen.findByText("Sign in to take the quiz")).toBeTruthy();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it.each([
    ["the quiz request", QUIZ],
    ["the chapters request", CHAPTERS],
  ])("shows the locked text and Back to course when %s answers 403 chapter_locked", async (_name, route) => {
    setup({ extra: { [route()]: () => errorResponse(403, "chapter_locked", "Locked.") } });
    renderApp(URL_OF_QUIZ);

    expect(await screen.findByText("This chapter is locked. Pass the previous chapter's quiz to unlock it.")).toBeTruthy();
    expect(href(screen.getByRole("link", { name: "Back to course" }))).toBe("/courses/demo");
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit answers" })).toBeNull();
  });

  it("shows Locked on a 403 from the submit, with no form", async () => {
    setup({ attempt: () => errorResponse(403, "chapter_locked", "Locked.") });
    const { user } = await loaded();
    await answerAll(user);
    await user.click(submitButton());
    expect(await screen.findByText("This chapter is locked. Pass the previous chapter's quiz to unlock it.")).toBeTruthy();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  it("shows Quiz not found and Back to course for chapter_not_found", async () => {
    setup({ extra: { [QUIZ()]: () => errorResponse(404, "chapter_not_found", "No such chapter.") } });
    renderApp(URL_OF_QUIZ);

    expect(await screen.findByRole("heading", { level: 1, name: "Quiz not found" })).toBeTruthy();
    await waitFor(() => expect(document.title).toBe("Quiz not found – Courses"));
    expect(href(screen.getByRole("link", { name: "Back to course" }))).toBe("/courses/demo");
  });

  it("shows Quiz not found and Back to all courses for course_not_found", async () => {
    setup({ extra: { [CHAPTERS()]: () => errorResponse(404, "course_not_found", "No such course.") } });
    renderApp(URL_OF_QUIZ);

    expect(await screen.findByRole("heading", { level: 1, name: "Quiz not found" })).toBeTruthy();
    expect(href(screen.getByRole("link", { name: "Back to all courses" }))).toBe("/");
    expect(screen.queryByRole("link", { name: "Back to course" })).toBeNull();
  });

  it("shows Quiz not found when the chapters list does not have the chapter", async () => {
    setup({ chapters: [] });
    renderApp(URL_OF_QUIZ);
    expect(await screen.findByRole("heading", { level: 1, name: "Quiz not found" })).toBeTruthy();
    expect(screen.queryByRole("group")).toBeNull();
  });
});

describe("load errors", () => {
  const cases: [string, Handler, string][] = [
    ["a 500", () => errorResponse(500, "internal_error", "The server broke."), "The server broke."],
    ["a non-JSON body", () => htmlResponse(502), UNEXPECTED_RESPONSE_MESSAGE],
    ["a network failure", () => Promise.reject(new TypeError("Failed to fetch")), NETWORK_ERROR_MESSAGE],
    ["a 200 that is not a quiz", () => jsonResponse({ questions: "nope" }), UNEXPECTED_RESPONSE_MESSAGE],
    ["a quiz with no questions", () => jsonResponse({ course_id: COURSE, chapter_id: CHAPTER, questions: [] }), UNEXPECTED_RESPONSE_MESSAGE],
    ["a question with no options", () => jsonResponse({ questions: [{ id: "q1", text: "t", snippet: null, options: [] }] }), UNEXPECTED_RESPONSE_MESSAGE],
    ["a 429 from a future change", () => errorResponse(429, "rate_limited", "Slow down.", { "Retry-After": "5" }), "Slow down."],
  ];

  it.each(cases)("shows the message in an alert with Try again for %s on the quiz request", async (_name, handler, message) => {
    setup({ extra: { [QUIZ()]: handler } });
    renderApp(URL_OF_QUIZ);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(message);
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("shows the error when only the chapters request fails, and does not show the form", async () => {
    setup({ extra: { [CHAPTERS()]: () => errorResponse(500, "internal_error", "Chapters broke.") } });
    renderApp(URL_OF_QUIZ);

    expect((await screen.findByRole("alert")).textContent).toContain("Chapters broke.");
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("shows the error when the chapters body is not a list", async () => {
    setup({ extra: { [CHAPTERS()]: () => jsonResponse({ chapters: "nope" }) } });
    renderApp(URL_OF_QUIZ);
    expect((await screen.findByRole("alert")).textContent).toContain(UNEXPECTED_RESPONSE_MESSAGE);
  });

  it("loads both requests again on Try again, and shows the form once they work", async () => {
    let asked = 0;
    const api = setup({
      extra: {
        [QUIZ()]: () => {
          asked += 1;
          return asked === 1 ? errorResponse(500, "internal_error", "Broke.") : jsonResponse(makeQuiz());
        },
      },
    });
    const { user } = await (async () => {
      const view = renderApp(URL_OF_QUIZ);
      await screen.findByRole("alert");
      return view;
    })();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("group", { name: /^Question 1\b/ })).toBeTruthy();
    expect(api.calls(QUIZ())).toHaveLength(2);
    expect(api.calls(CHAPTERS())).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("submit errors", () => {
  it("keeps the answers, shows the message above Submit answers, and sends a new POST on the second click after a network failure", async () => {
    let posts = 0;
    const api = setup({
      attempt: (call) => {
        posts += 1;
        return posts === 1 ? Promise.reject(new TypeError("Failed to fetch")) : jsonResponse(grade(call));
      },
    });
    const { user } = await loaded();
    await answerAll(user);
    await user.click(submitButton());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(NETWORK_ERROR_MESSAGE);
    expect(alert.compareDocumentPosition(submitButton()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(submitButton().textContent).toBe("Submit answers");
    expect(submitButton().hasAttribute("disabled")).toBe(false);
    expect((within(group(3)).getByRole("radio", { name: "Q3 option a" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("5 of 5 answered")).toBeTruthy();

    await user.click(submitButton());
    expect(await screen.findByRole("heading", { level: 2 })).toBeTruthy();
    expect(api.calls(ATTEMPT())).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the message of a 500 and lets the learner submit again", async () => {
    const api = setup({ attempt: () => errorResponse(500, "internal_error", "Could not grade.") });
    const { user } = await loaded();
    await answerAll(user);
    await user.click(submitButton());

    expect((await screen.findByRole("alert")).textContent).toBe("Could not grade.");
    expect(submitButton().hasAttribute("disabled")).toBe(false);
    await user.click(submitButton());
    await waitFor(() => expect(api.calls(ATTEMPT())).toHaveLength(2));
  });

  it("shows the message of a 429 from a future change and keeps the answers", async () => {
    setup({ attempt: () => errorResponse(429, "rate_limited", "Too many tries.", { "Retry-After": "30" }) });
    const { user } = await loaded();
    await answerAll(user);
    await user.click(submitButton());
    expect((await screen.findByRole("alert")).textContent).toBe("Too many tries.");
    expect(screen.getByText("5 of 5 answered")).toBeTruthy();
  });

  it("on a 422 says the quiz has changed, shows no form and not the server's message, and Reload quiz loads a fresh form", async () => {
    const api = setup({
      quizzes: [makeQuiz(), makeQuiz({ order: ["a", "b", "c"], tag: "n2-" })],
      attempt: () => errorResponse(422, "validation_error", "Unknown question q3 and option SERVER-MSG-SENTINEL."),
    });
    const { user } = await loaded();
    await answerAll(user);
    await user.click(submitButton());

    expect(await screen.findByText("This quiz has changed. Reload it to get the latest version.")).toBeTruthy();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(document.body.textContent).not.toContain("SERVER-MSG-SENTINEL");
    expect(screen.queryByRole("alert")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Reload quiz" }));
    await screen.findByRole("group", { name: /^Question 1\b/ });
    expect(api.calls(QUIZ())).toHaveLength(2);
    expect(api.calls(CHAPTERS())).toHaveLength(1);
    for (const radio of screen.getAllByRole("radio") as HTMLInputElement[]) expect(radio.checked).toBe(false);
    expect(within(group(1)).getAllByRole("radio").map((r) => r.closest("label")?.textContent)).toEqual(["Q1 option a", "Q1 option b", "Q1 option c"]);
    expect(h1().textContent).toBe("Quiz: Chapter one");
  });

  it.each([
    ["passed is neither true nor false", { passed: "yes", score: 5, total: 5 }],
    ["passed is missing", { score: 5, total: 5 }],
    ["a passed response has no results", { passed: true, score: 5, total: 5, next_chapter_id: null, course_complete: false }],
    ["a failed response has no wrong list", { passed: false, score: 1, total: 5 }],
    ["the body is a list", [1, 2]],
  ])("treats a 200 where %s as unexpected: generic message, answers stay, no crash", async (_name, body) => {
    const api = setup({ attempt: () => jsonResponse(body) });
    const { user } = await loaded();
    await answerAll(user);
    await user.click(submitButton());

    expect((await screen.findByRole("alert")).textContent).toBe(UNEXPECTED_RESPONSE_MESSAGE);
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(screen.getByText("5 of 5 answered")).toBeTruthy();
    expect(submitButton().hasAttribute("disabled")).toBe(false);
    await user.click(submitButton());
    await waitFor(() => expect(api.calls(ATTEMPT())).toHaveLength(2));
  });
});

describe("privacy", () => {
  const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;

  it("writes nothing anywhere through pick, submit, fail, try again, pick, submit, pass and retake", async () => {
    const SENT = "FLOW-SENTINEL-7f3a";
    const consoleSpies = CONSOLE_METHODS.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    localStorage.clear();
    sessionStorage.clear();
    const stateBefore = window.history.state;

    correctLabel = (n) => `${SENT}-${n}-a`;
    const text = (n: number, letter: string) => (letter === "a" ? `${SENT}-${n}-a` : `${SENT}-${n}-${letter}`);
    const quizWith = (tag: string, order: string[]) => {
      const quiz = makeQuiz({ tag, order });
      quiz.questions.forEach((q, i) => q.options.forEach((o) => (o.text = text(i + 1, o.id.slice(-1)))));
      return quiz;
    };
    const api = setup({
      quizzes: [quizWith(`${SENT}-id1-`, ["c", "a", "b"]), quizWith(`${SENT}-id2-`, ["b", "c", "a"]), quizWith(`${SENT}-id3-`, ["a", "b", "c"])],
    });
    const { user, history, currentUrl } = renderApp(`${URL_OF_QUIZ}?step=1#top`);
    await screen.findByRole("group", { name: /^Question 1\b/ });

    for (let n = 1; n <= 5; n++) await pick(user, n, text(n, "b"));
    await user.click(submitButton());
    await screen.findByRole("heading", { level: 2, name: /^You scored 0\/5/ });
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("group", { name: /^Question 1\b/ });
    for (let n = 1; n <= 5; n++) await pick(user, n, text(n, "a"));
    await user.click(submitButton());
    await screen.findByRole("heading", { level: 2, name: /^You passed/ });
    await user.click(screen.getByRole("button", { name: "Retake the quiz" }));
    await screen.findByRole("group", { name: /^Question 1\b/ });

    expect(api.calls(ATTEMPT())).toHaveLength(2);
    for (const spy of consoleSpies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain("SENTINEL");
      expect(JSON.stringify(spy.mock.calls)).not.toContain(SENT);
    }
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(window.history.state).toBe(stateBefore);
    expect(currentUrl()).toBe(`${URL_OF_QUIZ}?step=1#top`);
    expect(history).toHaveLength(1);
    expect(history[0].type).toBe("POP");
  });

  /** The app in a router with buttons that move through history. */
  function Jump() {
    const navigate = useNavigate();
    return (
      <>
        <button onClick={() => navigate("/courses/demo")}>go to dashboard</button>
        <button onClick={() => navigate("/courses/demo/chapters/c2/quiz")}>go to quiz two</button>
        <button onClick={() => navigate(-1)}>history back</button>
      </>
    );
  }
  afterEach(cleanup);
  function renderWithHistory(url: string, options: { strict?: boolean } = {}) {
    const user = userEvent.setup();
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const tree = (
      <MemoryRouter initialEntries={[url]}>
        <App />
        <Jump />
      </MemoryRouter>
    );
    return { user, ...render(tree), strict: options.strict };
  }

  it("shows a fresh quiz from a new GET, not the review, after leaving the page and going back", async () => {
    correctLabel = (n) => `${CORRECT}-${n}`;
    const api = setup({
      quizzes: [makeQuiz({ correctText: (n) => `${CORRECT}-${n}` })],
      extra: { "GET /api/courses": () => jsonResponse({ courses: [{ id: COURSE, title: "Demo", description: "d" }] }) },
    });
    const { user } = renderWithHistory(URL_OF_QUIZ);
    await screen.findByRole("group", { name: /^Question 1\b/ });
    await answerAll(user);
    await user.click(submitButton());
    await screen.findByRole("heading", { level: 2, name: "You passed with 5/5." });
    expect(document.body.innerHTML).toContain(EXPLANATION);

    await user.click(screen.getByRole("button", { name: "go to dashboard" }));
    await screen.findByRole("heading", { level: 1, name: "Demo" });
    expect(document.body.innerHTML).not.toContain(EXPLANATION);
    await user.click(screen.getByRole("button", { name: "history back" }));

    await screen.findByRole("group", { name: /^Question 1\b/ });
    expect(api.calls(QUIZ())).toHaveLength(2);
    expect(document.body.innerHTML).not.toContain(EXPLANATION);
    for (const radio of screen.getAllByRole("radio") as HTMLInputElement[]) expect(radio.checked).toBe(false);
  });

  it("drops the old questions at once and ignores a late answer when the URL changes to another quiz", async () => {
    const slow = deferred<Response>();
    const api = apiRoutes({
      "GET /api/auth/me": () => jsonResponse({ username: "ada_l" }),
      [QUIZ()]: () => slow.promise,
      [CHAPTERS()]: () => jsonResponse(chapterList()),
      [QUIZ(COURSE, "c2")]: () => jsonResponse(makeQuiz({ tag: "two-" })),
    });
    const { user } = renderWithHistory(URL_OF_QUIZ);
    await waitFor(() => expect(api.calls(QUIZ())).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "go to quiz two" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Quiz: Chapter two" })).toBeTruthy();
    await act(async () => {
      slow.resolve(jsonResponse({ ...makeQuiz(), questions: makeQuiz().questions.map((q) => ({ ...q, text: `OLD ${q.text}` })) }));
    });

    expect(document.body.textContent).not.toContain("OLD");
    expect(h1().textContent).toBe("Quiz: Chapter two");
    expect(screen.getAllByRole("radio")).toHaveLength(15);
  });

  it("clears answers and a review at once when the URL changes to another quiz", async () => {
    const slow = deferred<Response>();
    correctLabel = (n) => `${CORRECT}-${n}`;
    setup({
      quizzes: [makeQuiz({ correctText: (n) => `${CORRECT}-${n}` })],
      extra: { [QUIZ(COURSE, "c2")]: () => slow.promise, [CHAPTERS()]: () => jsonResponse(chapterList()) },
    });
    const { user } = renderWithHistory(URL_OF_QUIZ);
    await screen.findByRole("group", { name: /^Question 1\b/ });
    await answerAll(user);
    await user.click(submitButton());
    await screen.findByRole("heading", { level: 2, name: "You passed with 5/5." });

    await user.click(screen.getByRole("button", { name: "go to quiz two" }));

    expect(screen.getByRole("status").textContent).toBe("Loading…");
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(document.body.innerHTML).not.toContain(EXPLANATION);
    expect(document.body.innerHTML).not.toContain(CORRECT);
    slow.resolve(jsonResponse(makeQuiz({ tag: "two-" })));
    await screen.findByRole("group", { name: /^Question 1\b/ });
    for (const radio of screen.getAllByRole("radio") as HTMLInputElement[]) expect(radio.checked).toBe(false);
  });

  it("ignores a late response and warns about nothing when the learner leaves while submitting", async () => {
    const consoleSpies = CONSOLE_METHODS.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    const slow = deferred<Response>();
    const api = setup({
      attempt: () => slow.promise,
      extra: { "GET /api/courses": () => jsonResponse({ courses: [{ id: COURSE, title: "Demo", description: "d" }] }) },
    });
    const { user } = renderWithHistory(URL_OF_QUIZ);
    await screen.findByRole("group", { name: /^Question 1\b/ });
    await answerAll(user);
    await user.click(submitButton());
    await waitFor(() => expect(api.calls(ATTEMPT())).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "go to dashboard" }));
    await screen.findByRole("heading", { level: 1, name: "Demo" });
    await act(async () => {
      slow.resolve(jsonResponse(grade(api.calls(ATTEMPT())[0])));
    });

    expect(screen.queryByRole("heading", { level: 2, name: /You passed/ })).toBeNull();
    expect(h1().textContent).toBe("Demo");
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("StrictMode", () => {
  it("shows one form and works as usual", async () => {
    const api = setup();
    const { user } = await loaded(URL_OF_QUIZ, { strict: true });

    expect(screen.getAllByRole("group")).toHaveLength(5);
    expect(screen.getAllByRole("radio")).toHaveLength(15);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    await answerAll(user);
    await user.click(submitButton());
    expect(await screen.findByRole("heading", { level: 2, name: "You passed with 5/5." })).toBeTruthy();
    expect(api.calls(ATTEMPT())).toHaveLength(1);
  });

  it("moves focus once to the heading of a failed review", async () => {
    setup();
    const { user } = await loaded(URL_OF_QUIZ, { strict: true });
    await answerAll(user, 4);
    await user.click(submitButton());
    await screen.findByRole("heading", { level: 2 });
    await waitFor(() => expect(document.activeElement).toBe(h2()));
  });
});

describe("layout hooks", () => {
  it("renders the quiz inside one region and sets no inline style", async () => {
    setup();
    await loaded();
    expect(document.querySelectorAll("main [style]")).toHaveLength(0);
    expect(screen.getAllByRole("region", { name: "Quiz" })).toHaveLength(1);
  });

  it("makes Submit answers the one primary button, and Try again and Retake the quiz secondary", async () => {
    setup();
    const { user } = await loaded();
    expect(submitButton().className).toBe("button");
    expect(document.querySelectorAll("main button.button")).toHaveLength(1);
    await answerAll(user, 4);
    await user.click(submitButton());
    await screen.findByRole("heading", { level: 2 });
    expect(screen.getByRole("button", { name: "Try again" }).className).toBe("button button-secondary");
  });

  it("makes Retake the quiz a secondary button", async () => {
    setup();
    const { user } = await loaded();
    await answerAll(user);
    await user.click(submitButton());
    await screen.findByRole("heading", { level: 2 });
    expect(screen.getByRole("button", { name: "Retake the quiz" }).className).toBe("button button-secondary");
  });

  it("marks Correct and Incorrect with the words, not only a color", async () => {
    setup();
    const { user } = await loaded();
    await answerAll(user, 5);
    await user.click(submitButton());
    await screen.findByRole("heading", { level: 2 });
    expect(screen.getByText("Incorrect").className).toContain("quiz-incorrect");
    expect(screen.getAllByText("Correct")[0].className).toContain("quiz-correct");
  });
});
