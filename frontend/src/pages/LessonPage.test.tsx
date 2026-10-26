import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NETWORK_ERROR_MESSAGE, UNEXPECTED_RESPONSE_MESSAGE } from "../api/apiError";
import App from "../App";
import { signInPath } from "../auth/paths";
import allAssets from "../content-components/fixtures/all-assets.tree.json";
import markdown from "../content-components/fixtures/markdown.tree.json";
import welcome from "../content-components/fixtures/welcome.lesson.json";
import { apiRoutes, deferred } from "../test/apiRoutes";
import { errorResponse, htmlResponse, jsonResponse } from "../test/mockApi";
import { renderApp } from "../test/renderApp";
import { component, heading, paragraph, spyOnConsole, tab, text } from "../test/renderTree";

const learnerMe = () => jsonResponse({ username: "ada_l" });
const noContent = () => new Response(null, { status: 204 });
const PUT = "PUT /api/courses/demo/progress/last-lesson";
const lessonRoute = (id: string) => `GET /api/courses/demo/lessons/${id}`;

type Handler = NonNullable<Parameters<typeof apiRoutes>[0]>[string];

/** The API's answer for a lesson, with a tree like the build's: it starts with the title. */
function lesson(id: string, overrides: Record<string, unknown> = {}) {
  return {
    course_id: "demo",
    chapter_id: "c1",
    lesson_id: id,
    title: `Title of ${id}`,
    prev_lesson_id: null,
    next_lesson_id: null,
    tree: { type: "root", children: [heading(1, `Title of ${id}`), paragraph(text(`Body of ${id}`))] },
    ...overrides,
  };
}

/** Three lessons a, b, c in chapter c1; a is the first and c the last. */
const chapterOfThree: Record<string, unknown> = {
  a: lesson("a", { next_lesson_id: "b" }),
  b: lesson("b", { prev_lesson_id: "a", next_lesson_id: "c" }),
  c: lesson("c", { prev_lesson_id: "b" }),
};

function routes(options: { learner?: boolean; lessons?: Record<string, unknown>; extra?: Record<string, Handler> } = {}) {
  const lessons = options.lessons ?? chapterOfThree;
  return apiRoutes({
    ...(options.learner && { "GET /api/auth/me": learnerMe }),
    [PUT]: noContent,
    ...Object.fromEntries(Object.entries(lessons).map(([id, body]) => [lessonRoute(id), () => jsonResponse(body)])),
    ...options.extra,
  });
}

const href = (element: HTMLElement) => element.getAttribute("href");
const h1 = () => screen.getByRole("heading", { level: 1 });
const lessonNav = () => within(screen.getByRole("navigation", { name: "Lesson navigation" }));

describe("loading and the loaded lesson", () => {
  it("shows the h1 Lesson, the title Lesson – Courses and Loading… while it loads", async () => {
    const pending = deferred<Response>();
    routes({ extra: { [lessonRoute("a")]: () => pending.promise } });
    renderApp("/courses/demo/lessons/a");

    expect(h1().textContent).toBe("Lesson");
    await waitFor(() => expect(document.title).toBe("Lesson – Courses"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Loading…"));
    pending.resolve(jsonResponse(chapterOfThree.a));
    expect(await screen.findByText("Body of a")).toBeTruthy();
  });

  it("shows the lesson title as the h1 and the document title, then the tree", async () => {
    routes();
    renderApp("/courses/demo/lessons/a");

    expect(await screen.findByRole("heading", { level: 1, name: "Title of a" })).toBeTruthy();
    await waitFor(() => expect(document.title).toBe("Title of a – Courses"));
    expect(screen.getByText("Body of a")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows one h1 when the tree starts with a depth-1 heading that repeats the title", async () => {
    routes();
    renderApp("/courses/demo/lessons/a");
    await screen.findByText("Body of a");

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getAllByText("Title of a")).toHaveLength(1);
  });

  it("shows one h1, and another depth-1 heading as an h2", async () => {
    const tree = { type: "root", children: [heading(1, "Not the title"), paragraph(text("Body")), heading(1, "Title of a")] };
    routes({ lessons: { a: lesson("a", { tree }) } });
    renderApp("/courses/demo/lessons/a");
    await screen.findByText("Body");

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(h1().textContent).toBe("Title of a");
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Not the title", "Title of a"]);
  });

  it("shows only the title and the navigation for an empty tree", async () => {
    routes({ lessons: { a: lesson("a", { tree: { type: "root", children: [] } }) } });
    renderApp("/courses/demo/lessons/a");

    expect(await screen.findByRole("heading", { level: 1, name: "Title of a" })).toBeTruthy();
    expect(lessonNav().getByRole("link", { name: "Back to course" })).toBeTruthy();
    expect(document.querySelector(".lesson-content")?.childNodes).toHaveLength(0);
  });

  it("renders a copy of the real build's output, with the components it has built", async () => {
    const log = spyOnConsole();
    routes({ lessons: { a: lesson("a", { tree: allAssets }) } });
    renderApp("/courses/demo/lessons/a");

    expect(await screen.findAllByRole("tab")).toHaveLength(2);
    expect(document.querySelector("img[alt='A picture']")).toBeTruthy();
    expect(document.querySelector(".callout-note")).toBeTruthy();
    await waitFor(() => expect(log.error).toHaveBeenCalledTimes(1));
  });

  it("renders a copy of the Markdown golden tree", async () => {
    routes({ lessons: { a: lesson("a", { title: "Heading one", tree: markdown }) } });
    renderApp("/courses/demo/lessons/a");

    expect(await screen.findByRole("heading", { level: 1, name: "Heading one" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 6, name: "Heading six" })).toBeTruthy();
    expect(document.querySelector("ol[start='3']")).toBeTruthy();
  });

  it("renders a copy of a lesson from the sample course", async () => {
    routes({ lessons: { "01-welcome": { ...welcome, title: "Welcome", prev_lesson_id: null, next_lesson_id: null } } });
    renderApp("/courses/demo/lessons/01-welcome");
    expect(await screen.findByText("Welcome to the sample course.")).toBeTruthy();
  });
});

describe("waiting for the caller", () => {
  it("does not ask for the lesson until the auth state is known", async () => {
    const me = deferred<Response>();
    const api = routes({ extra: { "GET /api/auth/me": () => me.promise } });
    renderApp("/courses/demo/lessons/a");

    expect(screen.getByRole("status").textContent).toBe("Loading…");
    await waitFor(() => expect(api.calls("GET /api/auth/me")).toHaveLength(1));
    expect(api.calls(lessonRoute("a"))).toHaveLength(0);

    me.resolve(learnerMe());
    expect(await screen.findByText("Body of a")).toBeTruthy();
    expect(api.calls(lessonRoute("a"))).toHaveLength(1);
  });

  it("asks again for the new caller when a 401 turns a learner into a visitor, and does not loop", async () => {
    let asked = 0;
    const api = routes({
      learner: true,
      extra: {
        [lessonRoute("a")]: () => {
          asked += 1;
          return errorResponse(401, "not_authenticated", "Sign in to continue.");
        },
      },
    });
    renderApp("/courses/demo/lessons/a");

    expect(await screen.findByText("Sign in to read this lesson")).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    // Once as the learner, once as the visitor that the 401 made, and no more.
    expect(asked).toBe(2);
    expect(api.calls(PUT)).toHaveLength(0);
    expect(screen.getByRole("navigation", { name: "Account" }).textContent).toContain("Sign in");
  });

  it("shows the lesson once the visitor's second request works", async () => {
    let asked = 0;
    routes({
      learner: true,
      extra: {
        [lessonRoute("a")]: () => {
          asked += 1;
          return asked === 1 ? errorResponse(401, "not_authenticated", "Sign in to continue.") : jsonResponse(chapterOfThree.a);
        },
      },
    });
    renderApp("/courses/demo/lessons/a");

    expect(await screen.findByText("Body of a")).toBeTruthy();
    expect(lessonNav().getByRole("link", { name: "Next lesson" })).toBeTruthy();
  });
});

describe("lesson navigation", () => {
  it("on the first lesson has Back to course and Next lesson, and no Previous lesson", async () => {
    routes();
    renderApp("/courses/demo/lessons/a");
    await screen.findByText("Body of a");

    expect(href(lessonNav().getByRole("link", { name: "Back to course" }))).toBe("/courses/demo");
    expect(href(lessonNav().getByRole("link", { name: "Next lesson" }))).toBe("/courses/demo/lessons/b");
    expect(lessonNav().queryByRole("link", { name: "Previous lesson" })).toBeNull();
    expect(lessonNav().getAllByRole("link")).toHaveLength(2);
  });

  it("in the middle has Previous lesson and Next lesson", async () => {
    routes();
    renderApp("/courses/demo/lessons/b");
    await screen.findByText("Body of b");

    expect(href(lessonNav().getByRole("link", { name: "Previous lesson" }))).toBe("/courses/demo/lessons/a");
    expect(href(lessonNav().getByRole("link", { name: "Next lesson" }))).toBe("/courses/demo/lessons/c");
    expect(lessonNav().queryByRole("link", { name: "Back to course" })).toBeNull();
  });

  it("on the last lesson has Previous lesson and the chapter quiz for a learner", async () => {
    routes({ learner: true });
    renderApp("/courses/demo/lessons/c");
    await screen.findByText("Body of c");

    expect(href(lessonNav().getByRole("link", { name: "Previous lesson" }))).toBe("/courses/demo/lessons/b");
    expect(href(lessonNav().getByRole("link", { name: "Take the chapter quiz" }))).toBe("/courses/demo/chapters/c1/quiz");
    expect(lessonNav().queryByRole("link", { name: "Next lesson" })).toBeNull();
    expect(lessonNav().queryByRole("link", { name: "Sign in to take the quiz" })).toBeNull();
  });

  it("on the last lesson has Sign in to take the quiz for a visitor, and asks for no quiz page", async () => {
    const api = routes();
    renderApp("/courses/demo/lessons/c");
    await screen.findByText("Body of c");

    const signIn = lessonNav().getByRole("link", { name: "Sign in to take the quiz" });
    expect(href(signIn)).toBe(signInPath("/courses/demo/chapters/c1/quiz"));
    expect(href(signIn)).toBe("/login?next=/courses/demo/chapters/c1/quiz");
    expect(lessonNav().queryByRole("link", { name: "Take the chapter quiz" })).toBeNull();
    expect(api.calls().filter((call) => call.path.includes("quiz"))).toHaveLength(0);
  });

  it.each([
    ["a learner", true, "Take the chapter quiz", "/courses/demo/chapters/c1/quiz"],
    ["a visitor", false, "Sign in to take the quiz", "/login?next=/courses/demo/chapters/c1/quiz"],
  ])("on the only lesson of a chapter has Back to course and the quiz link for %s", async (_who, learner, label, to) => {
    routes({ learner, lessons: { only: lesson("only") }, extra: { [lessonRoute("only")]: () => jsonResponse(lesson("only")) } });
    renderApp("/courses/demo/lessons/only");
    await screen.findByText("Body of only");

    expect(href(lessonNav().getByRole("link", { name: "Back to course" }))).toBe("/courses/demo");
    expect(href(lessonNav().getByRole("link", { name: label }))).toBe(to);
    expect(lessonNav().queryByRole("link", { name: "Previous lesson" })).toBeNull();
    expect(lessonNav().queryByRole("link", { name: "Next lesson" })).toBeNull();
  });

  it("uses the chapter id of the response for the quiz link", async () => {
    routes({ learner: true, lessons: { a: lesson("a", { chapter_id: "02-other" }) } });
    renderApp("/courses/demo/lessons/a");
    await screen.findByText("Body of a");
    expect(href(lessonNav().getByRole("link", { name: "Take the chapter quiz" }))).toBe("/courses/demo/chapters/02-other/quiz");
  });

  it("makes each link at least 44px high and wide", async () => {
    routes();
    renderApp("/courses/demo/lessons/b");
    await screen.findByText("Body of b");
    // The .button style is checked in global.css; here, that the links use it.
    for (const link of lessonNav().getAllByRole("link")) expect(link.classList.contains("button")).toBe(true);
  });

  it("encodes ids in the request path and in every link", async () => {
    const odd = lesson("odd id%", {
      chapter_id: "chap ter/1",
      prev_lesson_id: "prev one",
      next_lesson_id: "100%",
    });
    const api = apiRoutes({
      [PUT.replace("demo", "my%20course")]: noContent,
      "GET /api/courses/my%20course/lessons/odd%20id%25": () => jsonResponse(odd),
    });
    renderApp("/courses/my%20course/lessons/odd%20id%25");
    await screen.findByText("Body of odd id%");

    expect(api.calls("GET /api/courses/my%20course/lessons/odd%20id%25")).toHaveLength(1);
    expect(href(lessonNav().getByRole("link", { name: "Previous lesson" }))).toBe("/courses/my%20course/lessons/prev%20one");
    expect(href(lessonNav().getByRole("link", { name: "Next lesson" }))).toBe("/courses/my%20course/lessons/100%25");
  });

  it("encodes the chapter id in the quiz link and the next path in the sign-in link", async () => {
    routes({ lessons: { a: lesson("a", { chapter_id: "chap ter" }) } });
    renderApp("/courses/demo/lessons/a");
    await screen.findByText("Body of a");
    expect(href(lessonNav().getByRole("link", { name: "Sign in to take the quiz" }))).toBe(
      signInPath("/courses/demo/chapters/chap%20ter/quiz"),
    );
  });
});

describe("moving between lessons", () => {
  it("scrolls to the top and focuses the same h1 element when Next is clicked", async () => {
    routes();
    const { user, scrollTo } = renderApp("/courses/demo/lessons/a");
    await screen.findByText("Body of a");
    const heading_ = h1();
    scrollTo.mockClear();

    await user.click(lessonNav().getByRole("link", { name: "Next lesson" }));
    expect(await screen.findByText("Body of b")).toBeTruthy();

    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(h1()).toBe(heading_);
    expect(h1().textContent).toBe("Title of b");
    await waitFor(() => expect(document.activeElement).toBe(h1()));
    await waitFor(() => expect(document.title).toBe("Title of b – Courses"));
  });

  it("shows Loading… and the title Lesson between two lessons, keeping the h1", async () => {
    const next = deferred<Response>();
    routes({ extra: { [lessonRoute("b")]: () => next.promise } });
    const { user } = renderApp("/courses/demo/lessons/a");
    await screen.findByText("Body of a");
    const heading_ = h1();

    await user.click(lessonNav().getByRole("link", { name: "Next lesson" }));

    expect(screen.getByRole("status").textContent).toBe("Loading…");
    expect(screen.queryByText("Body of a")).toBeNull();
    expect(h1()).toBe(heading_);
    expect(h1().textContent).toBe("Lesson");
    expect(document.activeElement).toBe(heading_);
    next.resolve(jsonResponse(chapterOfThree.b));
    await screen.findByText("Body of b");
    expect(document.activeElement).toBe(heading_);
  });
});

/** The app in a router with buttons that move through history, to move quickly and to go Back and Forward. */
function Jump() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate("/courses/demo/lessons/b")}>jump to b</button>
      <button onClick={() => navigate(-1)}>history back</button>
      <button onClick={() => navigate(1)}>history forward</button>
    </>
  );
}

afterEach(cleanup);

function renderWithHistory(url: string) {
  const user = userEvent.setup();
  const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  render(
    <MemoryRouter initialEntries={[url]}>
      <App />
      <Jump />
    </MemoryRouter>,
  );
  return { user, scrollTo };
}

describe("a quick move and the history", () => {
  it("ignores a slow answer for lesson a when the learner has moved on to lesson b", async () => {
    const slow = deferred<Response>();
    const api = routes({ learner: true, extra: { [lessonRoute("a")]: () => slow.promise } });
    const { user } = renderWithHistory("/courses/demo/lessons/a");
    await waitFor(() => expect(api.calls(lessonRoute("a"))).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "jump to b" }));
    expect(await screen.findByText("Body of b")).toBeTruthy();
    await act(async () => {
      slow.resolve(jsonResponse(chapterOfThree.a));
    });

    expect(screen.queryByText("Body of a")).toBeNull();
    expect(h1().textContent).toBe("Title of b");
    expect(href(lessonNav().getByRole("link", { name: "Previous lesson" }))).toBe("/courses/demo/lessons/a");
    // The last lesson saved is the one that is shown; the answer that was dropped saved nothing.
    expect(api.calls(PUT).map((call) => call.body)).toEqual([{ lesson_id: "b" }]);
  });

  it("ignores a slow answer for lesson b that arrives after Back to lesson a", async () => {
    const slow = deferred<Response>();
    routes({ extra: { [lessonRoute("b")]: () => slow.promise } });
    const { user } = renderWithHistory("/courses/demo/lessons/a");
    await screen.findByText("Body of a");

    await user.click(screen.getByRole("button", { name: "jump to b" }));
    await user.click(screen.getByRole("button", { name: "history back" }));
    expect(await screen.findByText("Body of a")).toBeTruthy();
    await act(async () => {
      slow.resolve(jsonResponse(chapterOfThree.b));
    });

    expect(screen.queryByText("Body of b")).toBeNull();
    expect(h1().textContent).toBe("Title of a");
  });

  it("focuses the h1, scrolls to the top and saves the lesson now shown on Back and Forward", async () => {
    const api = routes({ learner: true });
    const { user, scrollTo } = renderWithHistory("/courses/demo/lessons/a");
    await screen.findByText("Body of a");
    await user.click(screen.getByRole("button", { name: "jump to b" }));
    await screen.findByText("Body of b");

    scrollTo.mockClear();
    h1().blur();
    await user.click(screen.getByRole("button", { name: "history back" }));
    await screen.findByText("Body of a");
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(document.activeElement).toBe(h1());

    scrollTo.mockClear();
    h1().blur();
    await user.click(screen.getByRole("button", { name: "history forward" }));
    await screen.findByText("Body of b");
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(document.activeElement).toBe(h1());

    await waitFor(() => expect(api.calls(PUT).map((call) => (call.body as { lesson_id: string }).lesson_id)).toEqual(["a", "b", "a", "b"]));
  });
});

describe("saving the last lesson", () => {
  it("does not save lesson a again when the learner goes Back to it before lesson b has answered", async () => {
    const slow = deferred<Response>();
    const api = routes({ learner: true, extra: { [lessonRoute("b")]: () => slow.promise } });
    const { user } = renderWithHistory("/courses/demo/lessons/a");
    await screen.findByText("Body of a");
    await waitFor(() => expect(api.calls(PUT)).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "jump to b" }));
    await user.click(screen.getByRole("button", { name: "history back" }));
    expect(await screen.findByText("Body of a")).toBeTruthy();
    await act(async () => {
      slow.resolve(jsonResponse(chapterOfThree.b));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(api.calls(PUT).map((call) => call.body)).toEqual([{ lesson_id: "a" }]);
  });

  const lastLessonCalls = (api: ReturnType<typeof routes>) => api.calls(PUT);

  it("sends one PUT with the lesson id of the response for a learner", async () => {
    const api = routes({ learner: true, extra: { [lessonRoute("old-id")]: () => jsonResponse(lesson("canonical")) } });
    renderApp("/courses/demo/lessons/old-id");
    await screen.findByText("Body of canonical");

    await waitFor(() => expect(lastLessonCalls(api)).toHaveLength(1));
    expect(lastLessonCalls(api)[0].body).toEqual({ lesson_id: "canonical" });
  });

  it("sends it once under StrictMode", async () => {
    const api = routes({ learner: true });
    renderApp("/courses/demo/lessons/a", { strict: true });
    await screen.findByText("Body of a");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(lastLessonCalls(api)).toHaveLength(1);
    expect(lastLessonCalls(api)[0].body).toEqual({ lesson_id: "a" });
  });

  it("does not send it again when the page re-renders or a tab is switched", async () => {
    const tabs = component("Tabs", {}, [tab("One", paragraph(text("first"))), tab("Two", paragraph(text("second")))]);
    const api = routes({ learner: true, lessons: { a: lesson("a", { tree: { type: "root", children: [tabs] } }) } });
    const { user } = renderApp("/courses/demo/lessons/a");
    await waitFor(() => expect(lastLessonCalls(api)).toHaveLength(1));

    await user.click(await screen.findByRole("tab", { name: "Two" }));
    await user.click(screen.getByRole("tab", { name: "One" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(lastLessonCalls(api)).toHaveLength(1);
  });

  it("sends one for each lesson that is shown", async () => {
    const api = routes({ learner: true });
    const { user } = renderApp("/courses/demo/lessons/a");
    await screen.findByText("Body of a");
    await user.click(lessonNav().getByRole("link", { name: "Next lesson" }));
    await screen.findByText("Body of b");

    await waitFor(() => expect(lastLessonCalls(api)).toHaveLength(2));
    expect(lastLessonCalls(api).map((call) => call.body)).toEqual([{ lesson_id: "a" }, { lesson_id: "b" }]);
  });

  it("does not send it for a visitor", async () => {
    const api = routes();
    renderApp("/courses/demo/lessons/a");
    await screen.findByText("Body of a");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(lastLessonCalls(api)).toHaveLength(0);
  });

  it("does not send it while the lesson is loading", async () => {
    const pending = deferred<Response>();
    const api = routes({ learner: true, extra: { [lessonRoute("a")]: () => pending.promise } });
    renderApp("/courses/demo/lessons/a");
    await waitFor(() => expect(api.calls(lessonRoute("a"))).toHaveLength(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(lastLessonCalls(api)).toHaveLength(0);
  });

  it.each([
    ["a 500", () => errorResponse(500, "internal_error", "Server broke.")],
    ["a 404", () => errorResponse(404, "lesson_not_found", "No such lesson.")],
    ["a 403", () => errorResponse(403, "chapter_locked", "Locked.")],
    ["a malformed answer", () => jsonResponse({ nope: true })],
  ])("does not send it after %s", async (_name, answer) => {
    const api = routes({ learner: true, extra: { [lessonRoute("a")]: answer } });
    renderApp("/courses/demo/lessons/a");
    await waitFor(() => expect(api.calls(lessonRoute("a"))).toHaveLength(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(lastLessonCalls(api)).toHaveLength(0);
  });

  it.each([
    ["a 500", () => errorResponse(500, "internal_error", "Server broke.")],
    ["a 401", () => errorResponse(401, "not_authenticated", "Sign in.")],
    ["a network error", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["an HTML 502", () => htmlResponse(502)],
  ])("shows nothing and does not retry when the PUT fails with %s", async (_name, answer) => {
    const api = routes({ learner: true, extra: { [PUT]: answer } });
    renderApp("/courses/demo/lessons/a");
    await screen.findByText("Body of a");
    await waitFor(() => expect(lastLessonCalls(api)).toHaveLength(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(lastLessonCalls(api)).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Body of a")).toBeTruthy();
  });
});

describe("errors", () => {
  it("asks a visitor to sign in on a 401, with a link back to this page", async () => {
    routes({ extra: { [lessonRoute("a")]: () => errorResponse(401, "not_authenticated", "Sign in to continue.") } });
    renderApp("/courses/demo/lessons/a?x=1");

    expect(await screen.findByText("Sign in to read this lesson")).toBeTruthy();
    expect(h1().textContent).toBe("Lesson");
    await waitFor(() => expect(document.title).toBe("Lesson – Courses"));
    const signIn = within(screen.getByRole("region", { name: "Lesson" })).getByRole("link", { name: "Sign in" });
    expect(signIn.getAttribute("href")).toBe(signInPath("/courses/demo/lessons/a?x=1"));
    expect(screen.queryByRole("navigation", { name: "Lesson navigation" })).toBeNull();
  });

  it("asks a visitor once, without a loop", async () => {
    const api = routes({ extra: { [lessonRoute("a")]: () => errorResponse(401, "not_authenticated", "Sign in to continue.") } });
    renderApp("/courses/demo/lessons/a");
    await screen.findByText("Sign in to read this lesson");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(api.calls(lessonRoute("a"))).toHaveLength(1);
  });

  it("shows the design-system text, not the server's, for a locked chapter", async () => {
    routes({
      learner: true,
      extra: { [lessonRoute("a")]: () => errorResponse(403, "chapter_locked", "Finish the earlier chapters to unlock this chapter.") },
    });
    renderApp("/courses/demo/lessons/a");

    expect(await screen.findByText("This chapter is locked. Pass the previous chapter's quiz to unlock it.")).toBeTruthy();
    expect(screen.queryByText(/Finish the earlier chapters/)).toBeNull();
    expect(h1().textContent).toBe("Lesson");
    await waitFor(() => expect(document.title).toBe("Lesson – Courses"));
    expect(href(screen.getByRole("link", { name: "Back to course" }))).toBe("/courses/demo");
  });

  it.each(["lesson_not_found", "course_not_found"])("shows Lesson not found for a 404 %s", async (code) => {
    routes({ extra: { [lessonRoute("a")]: () => errorResponse(404, code, "Nothing here.") } });
    renderApp("/courses/demo/lessons/a");

    expect(await screen.findByRole("heading", { level: 1, name: "Lesson not found" })).toBeTruthy();
    await waitFor(() => expect(document.title).toBe("Lesson not found – Courses"));
    expect(href(screen.getByRole("link", { name: "Back to course" }))).toBe("/courses/demo");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it.each([
    ["a 500", () => errorResponse(500, "internal_error", "Server broke."), "Server broke."],
    ["a 429", () => errorResponse(429, "rate_limited", "Slow down."), "Slow down."],
    ["a 403 with another code", () => errorResponse(403, "forbidden", "Not allowed."), "Not allowed."],
    ["a 404 with another code", () => errorResponse(404, "not_found", "No route."), "No route."],
    ["a network error", () => Promise.reject(new TypeError("Failed to fetch")), NETWORK_ERROR_MESSAGE],
    ["an HTML 502", () => htmlResponse(502), UNEXPECTED_RESPONSE_MESSAGE],
    ["an HTML 200", () => htmlResponse(200, "<html></html>"), UNEXPECTED_RESPONSE_MESSAGE],
    ["a 200 that is not a lesson", () => jsonResponse({ hello: "world" }), UNEXPECTED_RESPONSE_MESSAGE],
    ["a 200 that is null", () => jsonResponse(null), UNEXPECTED_RESPONSE_MESSAGE],
    ["a 200 without a title", () => jsonResponse({ ...(chapterOfThree.a as object), title: undefined }), UNEXPECTED_RESPONSE_MESSAGE],
    ["a 200 with a prev id that is a number", () => jsonResponse({ ...(chapterOfThree.a as object), prev_lesson_id: 4 }), UNEXPECTED_RESPONSE_MESSAGE],
    ["a 200 with a tree that is a string", () => jsonResponse(lesson("a", { tree: "root" })), UNEXPECTED_RESPONSE_MESSAGE],
    ["a 200 with another root type", () => jsonResponse(lesson("a", { tree: { type: "doc", children: [] } })), UNEXPECTED_RESPONSE_MESSAGE],
    ["a 200 with no children", () => jsonResponse(lesson("a", { tree: { type: "root" } })), UNEXPECTED_RESPONSE_MESSAGE],
    ["a 200 with children that is not a list", () => jsonResponse(lesson("a", { tree: { type: "root", children: {} } })), UNEXPECTED_RESPONSE_MESSAGE],
    ["a 200 with a child that is not an object", () => jsonResponse(lesson("a", { tree: { type: "root", children: ["x"] } })), UNEXPECTED_RESPONSE_MESSAGE],
  ])("shows the error message and Try again for %s", async (_name, answer, message) => {
    routes({ extra: { [lessonRoute("a")]: answer } });
    renderApp("/courses/demo/lessons/a");

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(message)).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(h1().textContent).toBe("Lesson");
    await waitFor(() => expect(document.title).toBe("Lesson – Courses"));
    expect(screen.queryByRole("navigation", { name: "Lesson navigation" })).toBeNull();
  });

  it("asks again on Try again, shows Loading… and moves focus to the page region", async () => {
    const second = deferred<Response>();
    let asked = 0;
    const api = routes({
      extra: {
        [lessonRoute("a")]: () => {
          asked += 1;
          return asked === 1 ? errorResponse(500, "internal_error", "Server broke.") : second.promise;
        },
      },
    });
    const { user } = renderApp("/courses/demo/lessons/a");
    await user.click(await screen.findByRole("button", { name: "Try again" }));

    expect(screen.getByRole("status").textContent).toBe("Loading…");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Lesson" }));

    second.resolve(jsonResponse(chapterOfThree.a));
    expect(await screen.findByText("Body of a")).toBeTruthy();
    expect(api.calls(lessonRoute("a"))).toHaveLength(2);
    expect(h1().textContent).toBe("Title of a");
  });

  it("shows the error again when Try again fails again", async () => {
    routes({ extra: { [lessonRoute("a")]: () => errorResponse(500, "internal_error", "Server broke.") } });
    const { user } = renderApp("/courses/demo/lessons/a");
    await user.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Server broke.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
