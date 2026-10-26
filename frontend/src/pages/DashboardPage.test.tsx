import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NETWORK_ERROR_MESSAGE, UNEXPECTED_RESPONSE_MESSAGE } from "../api/apiError";
import { apiRoutes, deferred } from "../test/apiRoutes";
import { errorResponse, htmlResponse, jsonResponse } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

type Status = "locked" | "in_progress" | "passed";

const course = { id: "demo", title: "Demo course", description: "Learn the demo.", chapter_count: 3 };

function chapter(id: string, title: string, free_preview: boolean, lessons: string[], status: Status | null = null) {
  return { id, title, free_preview, status, lessons: lessons.map((l) => ({ id: l, title: `Lesson ${l}` })) };
}

const chapters = [
  chapter("c1", "First steps", true, ["a", "b"]),
  chapter("c2", "Middle part", false, ["c", "d"]),
  chapter("c3", "Last part", false, ["e"]),
];

function progressEntry(id: string, status: Status, best_score: number | null, last_lesson_id: string | null) {
  return { id, status, best_score, last_lesson_id };
}

function progress(entries: ReturnType<typeof progressEntry>[], course_complete = false) {
  return { course_id: "demo", chapters: entries, course_complete };
}

const learnerMe = () => jsonResponse({ username: "ada_l" });

/** Routes for a dashboard test: a visitor unless `progressBody` is given. */
function routes(options: { progressBody?: unknown; chaptersBody?: unknown } = {}) {
  return apiRoutes({
    ...(options.progressBody !== undefined && {
      "GET /api/auth/me": learnerMe,
      "GET /api/courses/demo/progress": () => jsonResponse(options.progressBody),
    }),
    "GET /api/courses": () => jsonResponse({ courses: [course] }),
    "GET /api/courses/demo/chapters": () =>
      jsonResponse(options.chaptersBody ?? { course_id: "demo", chapters }),
  });
}

function card(title: string) {
  const heading = screen.getByRole("heading", { level: 2, name: title });
  return within(heading.closest("li") as HTMLElement);
}

const href = (link: HTMLElement) => link.getAttribute("href");

it("shows the course title, description and document title, with the chapters in API order", async () => {
  routes();
  renderApp("/courses/demo");

  expect(await screen.findByRole("heading", { level: 1, name: "Demo course" })).toBeTruthy();
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(screen.getByText("Learn the demo.")).toBeTruthy();
  // The title is set in an effect, which can run after the heading shows.
  await waitFor(() => expect(document.title).toBe("Demo course – Courses"));
  const titles = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
  expect(titles.slice(-3)).toEqual(["First steps", "Middle part", "Last part"]);
  const lessons = within(card("First steps").getByRole("list")).getAllByRole("listitem");
  expect(lessons.map((li) => li.textContent)).toEqual(["Lesson a", "Lesson b"]);
});

it("shows a visitor the chapters with free-preview links only, Start reading, and no progress call", async () => {
  const api = routes();
  renderApp("/courses/demo");
  await screen.findByRole("heading", { level: 1, name: "Demo course" });

  expect(href(card("First steps").getByRole("link", { name: "Lesson a" }))).toBe("/courses/demo/lessons/a");
  expect(card("First steps").getByRole("link", { name: "Lesson b" })).toBeTruthy();
  expect(card("Middle part").queryByRole("link")).toBeNull();
  expect(card("Middle part").getByText("Lesson c")).toBeTruthy();
  expect(card("Last part").queryByRole("link")).toBeNull();
  expect(href(screen.getByRole("link", { name: "Start reading" }))).toBe("/courses/demo/lessons/a");
  for (const text of ["Locked", "In progress", "Passed", "Not attempted", "Resume", "Start course"]) {
    expect(screen.queryByText(text)).toBeNull();
  }
  expect(screen.queryByText(/Best score/)).toBeNull();
  expect(screen.queryByRole("link", { name: /quiz/i })).toBeNull();
  expect(api.calls("GET /api/courses/demo/progress")).toHaveLength(0);
});

it("gives a visitor a labelled sign-in prompt with sign-in and register links back to the course", async () => {
  routes();
  renderApp("/courses/demo");

  const prompt = within(await screen.findByRole("region", { name: "Sign in to save your progress and take quizzes" }));
  expect(href(prompt.getByRole("link", { name: "Sign in" }))).toBe("/login?next=/courses/demo");
  expect(href(prompt.getByRole("link", { name: "Create account" }))).toBe("/register?next=/courses/demo");
});

it("hides Start reading when no free-preview chapter has a lesson", async () => {
  routes({ chaptersBody: { course_id: "demo", chapters: [chapter("c1", "Empty preview", true, []), chapters[1]] } });
  renderApp("/courses/demo");

  await screen.findByRole("heading", { level: 2, name: "Empty preview" });
  expect(screen.queryByRole("link", { name: "Start reading" })).toBeNull();
});

it("says Start course for a new learner and goes to the first lesson of the first chapter", async () => {
  routes({
    progressBody: progress([
      progressEntry("c1", "in_progress", null, null),
      progressEntry("c2", "locked", null, null),
      progressEntry("c3", "locked", null, null),
    ]),
  });
  renderApp("/courses/demo");

  const start = await screen.findByRole("link", { name: "Start course" });
  expect(href(start)).toBe("/courses/demo/lessons/a");
  expect(start.className).toContain("button");
  expect(screen.queryByRole("link", { name: "Resume" })).toBeNull();
  expect(screen.queryByRole("region", { name: /Sign in to save/ })).toBeNull();
});

it("shows a learner mid-course statuses, scores, lesson links, locked note, and quiz links", async () => {
  routes({
    progressBody: progress([
      progressEntry("c1", "passed", 5, "b"),
      progressEntry("c2", "in_progress", null, "d"),
      progressEntry("c3", "locked", null, null),
    ]),
  });
  renderApp("/courses/demo");

  const resume = await screen.findByRole("link", { name: "Resume" });
  expect(href(resume)).toBe("/courses/demo/lessons/d");
  expect(resume.className).toContain("button");

  const first = card("First steps");
  expect(first.getByText("Passed")).toBeTruthy();
  expect(first.getByText("Best score: 5/5")).toBeTruthy();
  expect(href(first.getByRole("link", { name: "Lesson a" }))).toBe("/courses/demo/lessons/a");
  expect(href(first.getByRole("link", { name: "Retake the quiz" }))).toBe("/courses/demo/chapters/c1/quiz");
  expect(first.queryByRole("link", { name: "Take the quiz" })).toBeNull();

  const middle = card("Middle part");
  expect(middle.getByText("In progress")).toBeTruthy();
  expect(middle.getByText("Not attempted")).toBeTruthy();
  expect(href(middle.getByRole("link", { name: "Lesson c" }))).toBe("/courses/demo/lessons/c");
  expect(href(middle.getByRole("link", { name: "Take the quiz" }))).toBe("/courses/demo/chapters/c2/quiz");

  const last = card("Last part");
  expect(last.getByText("Locked")).toBeTruthy();
  expect(last.queryByRole("link")).toBeNull();
  expect(last.getByText("Lesson e")).toBeTruthy();
  const note = "This chapter is locked. Pass the previous chapter's quiz to unlock it.";
  expect(screen.getAllByText(note)).toHaveLength(1);
  expect(last.getByText(note)).toBeTruthy();
  expect(screen.getAllByRole("link", { name: "Resume" })).toHaveLength(1);
  expect(document.querySelectorAll("a.button")).toHaveLength(1);
});

it("goes to the chapter's first lesson when last_lesson_id is not one of its lessons", async () => {
  routes({
    progressBody: progress([
      progressEntry("c1", "passed", 4, "b"),
      progressEntry("c2", "in_progress", null, "gone"),
      progressEntry("c3", "locked", null, null),
    ]),
  });
  renderApp("/courses/demo");

  expect(href(await screen.findByRole("link", { name: "Resume" }))).toBe("/courses/demo/lessons/c");
});

it("says Resume and goes to the first lesson when last_lesson_id is null but a chapter is passed", async () => {
  routes({
    progressBody: progress([
      progressEntry("c1", "passed", 3, null),
      progressEntry("c2", "in_progress", null, null),
      progressEntry("c3", "locked", null, null),
    ]),
  });
  renderApp("/courses/demo");

  expect(href(await screen.findByRole("link", { name: "Resume" }))).toBe("/courses/demo/lessons/c");
  expect(screen.queryByRole("link", { name: "Start course" })).toBeNull();
});

it("renders out-of-order statuses as given and resumes the first in-progress chapter", async () => {
  routes({
    progressBody: progress([
      progressEntry("c1", "in_progress", 2, "a"),
      progressEntry("c2", "passed", 5, "d"),
      progressEntry("c3", "locked", null, null),
    ]),
  });
  renderApp("/courses/demo");

  expect(href(await screen.findByRole("link", { name: "Resume" }))).toBe("/courses/demo/lessons/a");
  expect(card("First steps").getByText("In progress")).toBeTruthy();
  expect(card("First steps").getByText("Best score: 2/5")).toBeTruthy();
  expect(card("Middle part").getByText("Passed")).toBeTruthy();
  expect(card("Last part").getByText("Locked")).toBeTruthy();
});

it("ignores unknown progress chapters and falls back to the chapters status when progress has no entry", async () => {
  routes({
    progressBody: progress([progressEntry("ghost", "passed", 5, "z"), progressEntry("c1", "in_progress", null, null)]),
    chaptersBody: {
      course_id: "demo",
      chapters: [chapters[0], chapter("c2", "Middle part", false, ["c"], "locked")],
    },
  });
  renderApp("/courses/demo");

  await screen.findByRole("heading", { level: 2, name: "Middle part" });
  // The unknown "ghost" chapter adds nothing: no "Passed" label and no extra card.
  expect(screen.queryByText("Passed")).toBeNull();
  expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);
  const middle = card("Middle part");
  expect(middle.getByText("Locked")).toBeTruthy();
  expect(middle.getByText("Not attempted")).toBeTruthy();
});

it("shows Course complete without Resume, with every score, status, lesson link and a retake link", async () => {
  routes({
    progressBody: progress(
      [progressEntry("c1", "passed", 5, "a"), progressEntry("c2", "passed", 4, "c"), progressEntry("c3", "passed", 5, "e")],
      true,
    ),
  });
  renderApp("/courses/demo");

  expect(await screen.findByRole("heading", { level: 2, name: "Course complete" })).toBeTruthy();
  expect(screen.getByText("You have passed every chapter. You can review any lesson below.")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Resume" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Start course" })).toBeNull();
  expect(screen.getAllByText("Passed")).toHaveLength(3);
  expect(screen.getByText("Best score: 4/5")).toBeTruthy();
  for (const lesson of ["a", "b", "c", "d", "e"]) {
    expect(screen.getByRole("link", { name: `Lesson ${lesson}` })).toBeTruthy();
  }
  expect(screen.getAllByRole("link", { name: "Retake the quiz" })).toHaveLength(3);
});

it("shows no Resume button and does not crash when the course has no chapters or lessons", async () => {
  routes({
    progressBody: progress([progressEntry("c1", "in_progress", null, null)]),
    chaptersBody: { course_id: "demo", chapters: [chapter("c1", "Empty chapter", true, [])] },
  });
  renderApp("/courses/demo");

  expect(await screen.findByRole("heading", { level: 2, name: "Empty chapter" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /Resume|Start course/ })).toBeNull();
});

it("shows the dashboard of a course with no chapters", async () => {
  routes({ progressBody: progress([]), chaptersBody: { course_id: "demo", chapters: [] } });
  renderApp("/courses/demo");

  expect(await screen.findByRole("heading", { level: 1, name: "Demo course" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /Resume|Start course/ })).toBeNull();
});

it("links a free-preview lesson of a locked chapter, but never its quiz", async () => {
  routes({
    progressBody: progress([progressEntry("c1", "locked", null, null)]),
    chaptersBody: { course_id: "demo", chapters: [chapters[0]] },
  });
  renderApp("/courses/demo");

  await screen.findByRole("heading", { level: 2, name: "First steps" });
  expect(screen.getByRole("link", { name: "Lesson a" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /quiz/i })).toBeNull();
});

it("encodes ids in the links", async () => {
  routes({
    progressBody: progress([progressEntry("c 1", "in_progress", null, null)]),
    chaptersBody: { course_id: "demo", chapters: [chapter("c 1", "Odd ids", true, ["l/1"])] },
  });
  renderApp("/courses/demo");

  expect(href(await screen.findByRole("link", { name: "Lesson l/1" }))).toBe("/courses/demo/lessons/l%2F1");
  expect(href(screen.getByRole("link", { name: "Take the quiz" }))).toBe("/courses/demo/chapters/c%201/quiz");
});

it("says Course not found with a link back when the course list has no such id", async () => {
  apiRoutes({
    "GET /api/courses": () => jsonResponse({ courses: [course] }),
    "GET /api/courses/other/chapters": () => jsonResponse({ course_id: "other", chapters: [] }),
  });
  renderApp("/courses/other");

  expect(await screen.findByRole("heading", { level: 1, name: "Course not found" })).toBeTruthy();
  expect(href(screen.getByRole("link", { name: "Back to all courses" }))).toBe("/");
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(screen.queryByRole("list")).toBeNull();
});

it("says Course not found when the chapters call answers 404 course_not_found", async () => {
  apiRoutes({
    "GET /api/courses": () => jsonResponse({ courses: [course] }),
    "GET /api/courses/demo/chapters": () => errorResponse(404, "course_not_found", "No such course."),
  });
  renderApp("/courses/demo");

  expect(await screen.findByRole("heading", { level: 1, name: "Course not found" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});

it("says Course not found when the progress call answers 404 course_not_found", async () => {
  apiRoutes({
    "GET /api/auth/me": learnerMe,
    "GET /api/courses": () => jsonResponse({ courses: [course] }),
    "GET /api/courses/demo/chapters": () => jsonResponse({ course_id: "demo", chapters }),
    "GET /api/courses/demo/progress": () => errorResponse(404, "course_not_found", "No such course."),
  });
  renderApp("/courses/demo");

  expect(await screen.findByRole("heading", { level: 1, name: "Course not found" })).toBeTruthy();
  expect(screen.queryByRole("list")).toBeNull();
});

it("shows Loading… with role status and no chapters while the requests run", async () => {
  const slow = deferred<Response>();
  apiRoutes({
    "GET /api/courses": () => slow.promise,
    "GET /api/courses/demo/chapters": () => jsonResponse({ course_id: "demo", chapters }),
  });
  renderApp("/courses/demo");

  expect(screen.getByRole("status").textContent).toBe("Loading…");
  expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  slow.resolve(jsonResponse({ courses: [course] }));
  expect(await screen.findByRole("heading", { level: 1, name: "Demo course" })).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
});

it("shows Loading… and sends no progress request while the session is unknown, then loads progress for a learner", async () => {
  const me = deferred<Response>();
  const api = apiRoutes({
    "GET /api/auth/me": () => me.promise,
    "GET /api/courses": () => jsonResponse({ courses: [course] }),
    "GET /api/courses/demo/chapters": () => jsonResponse({ course_id: "demo", chapters }),
    "GET /api/courses/demo/progress": () =>
      jsonResponse(progress([progressEntry("c1", "in_progress", null, null)])),
  });
  renderApp("/courses/demo");

  expect(screen.getByRole("status").textContent).toBe("Loading…");
  expect(api.calls("GET /api/courses")).toHaveLength(0);
  expect(api.calls("GET /api/courses/demo/progress")).toHaveLength(0);
  me.resolve(learnerMe());
  expect(await screen.findByRole("link", { name: "Start course" })).toBeTruthy();
  expect(api.calls("GET /api/courses/demo/progress")).toHaveLength(1);
});

it("shows the server message and a Try again button for a 500", async () => {
  apiRoutes({
    "GET /api/courses": () => jsonResponse({ courses: [course] }),
    "GET /api/courses/demo/chapters": () => errorResponse(500, "internal_error", "Server broke."),
  });
  renderApp("/courses/demo");

  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("Server broke.")).toBeTruthy();
  expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
});

it("shows the generic network message when a request cannot be sent", async () => {
  apiRoutes({
    "GET /api/courses": () => jsonResponse({ courses: [course] }),
    "GET /api/courses/demo/chapters": () => Promise.reject(new TypeError("Failed to fetch")),
  });
  renderApp("/courses/demo");

  expect(within(await screen.findByRole("alert")).getByText(NETWORK_ERROR_MESSAGE)).toBeTruthy();
});

it("shows only the generic message for a 502 HTML page", async () => {
  apiRoutes({
    "GET /api/courses": () => htmlResponse(502),
    "GET /api/courses/demo/chapters": () => jsonResponse({ course_id: "demo", chapters }),
  });
  renderApp("/courses/demo");

  expect(within(await screen.findByRole("alert")).getByText(UNEXPECTED_RESPONSE_MESSAGE)).toBeTruthy();
  expect(document.body.textContent).not.toContain("Bad Gateway");
});

it("shows an error when only the progress call fails with a 500", async () => {
  apiRoutes({
    "GET /api/auth/me": learnerMe,
    "GET /api/courses": () => jsonResponse({ courses: [course] }),
    "GET /api/courses/demo/chapters": () => jsonResponse({ course_id: "demo", chapters }),
    "GET /api/courses/demo/progress": () => errorResponse(500, "internal_error", "Progress broke."),
  });
  renderApp("/courses/demo");

  expect(within(await screen.findByRole("alert")).getByText("Progress broke.")).toBeTruthy();
});

it("repeats the requests on Try again, showing Loading… and moving focus to the page region", async () => {
  let attempt = 0;
  const second = deferred<Response>();
  const api = apiRoutes({
    "GET /api/courses": () => jsonResponse({ courses: [course] }),
    "GET /api/courses/demo/chapters": () => {
      attempt += 1;
      return attempt === 1 ? errorResponse(500, "internal_error", "Server broke.") : second.promise;
    },
  });
  const { user } = renderApp("/courses/demo");
  await user.click(await screen.findByRole("button", { name: "Try again" }));

  expect(screen.getByRole("status").textContent).toBe("Loading…");
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("region", { name: "Course dashboard" }));
  second.resolve(jsonResponse({ course_id: "demo", chapters }));
  expect(await screen.findByRole("heading", { level: 2, name: "First steps" })).toBeTruthy();
  expect(api.calls("GET /api/courses/demo/chapters")).toHaveLength(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("becomes the visitor view without an error when the progress call answers 401", async () => {
  let me = 0;
  const api = apiRoutes({
    "GET /api/auth/me": () => {
      me += 1;
      return learnerMe();
    },
    "GET /api/courses": () => jsonResponse({ courses: [course] }),
    "GET /api/courses/demo/chapters": () => jsonResponse({ course_id: "demo", chapters }),
    "GET /api/courses/demo/progress": () => errorResponse(401, "not_authenticated", "Sign in to continue."),
  });
  renderApp("/courses/demo");

  expect(await screen.findByRole("link", { name: "Start reading" })).toBeTruthy();
  expect(me).toBe(1);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("region", { name: "Sign in to save your progress and take quizzes" })).toBeTruthy();
  for (const text of ["Locked", "In progress", "Passed", "Not attempted"]) {
    expect(screen.queryByText(text)).toBeNull();
  }
  expect(screen.queryByRole("link", { name: /Resume|Start course|quiz/i })).toBeNull();
  await waitFor(() => expect(api.calls("GET /api/courses/demo/progress")).toHaveLength(1));
});

/** Lets a held-back response's continuation run before the test looks at the page. */
const settleOldResponse = () => act(() => new Promise<void>((done) => setTimeout(done, 20)));

it("ignores a chapters answer from before the session ended, and shows the visitor view", async () => {
  const oldChapters = deferred<Response>();
  let chaptersCalls = 0;
  const api = apiRoutes({
    "GET /api/auth/me": learnerMe,
    "GET /api/courses": () => jsonResponse({ courses: [course] }),
    "GET /api/courses/demo/chapters": () => {
      chaptersCalls += 1;
      return chaptersCalls === 1 ? oldChapters.promise : jsonResponse({ course_id: "demo", chapters });
    },
    "GET /api/courses/demo/progress": () => errorResponse(401, "not_authenticated", "Sign in to continue."),
  });
  renderApp("/courses/demo");

  // The progress 401 turns the page into the visitor view, which loads again.
  expect(await screen.findByRole("link", { name: "Start reading" })).toBeTruthy();
  expect(api.calls("GET /api/courses/demo/chapters")).toHaveLength(2);
  oldChapters.resolve(jsonResponse({ course_id: "demo", chapters: [chapter("old", "Old chapter", true, ["z"])] }));
  await settleOldResponse();

  expect(screen.getByRole("link", { name: "Start reading" })).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByRole("heading", { level: 2, name: "Old chapter" })).toBeNull();
  expect(screen.getByRole("heading", { level: 2, name: "First steps" })).toBeTruthy();
});

it("shows Loading…, not the answer of a request that started before the session check restarted", async () => {
  const oldChapters = deferred<Response>();
  const secondMe = deferred<Response>();
  const secondChapters = deferred<Response>();
  let me = 0;
  let chaptersCalls = 0;
  apiRoutes({
    "GET /api/auth/me": () => {
      me += 1;
      return me === 1 ? errorResponse(500, "internal_error", "Session check broke.") : secondMe.promise;
    },
    "GET /api/courses": () => jsonResponse({ courses: [course] }),
    "GET /api/courses/demo/chapters": () => {
      chaptersCalls += 1;
      return chaptersCalls === 1 ? oldChapters.promise : secondChapters.promise;
    },
  });
  const { user } = renderApp("/courses/demo");

  // The visitor load is under way when the banner's Try again starts the session check again.
  await user.click(await screen.findByRole("button", { name: "Try again" }));
  oldChapters.resolve(jsonResponse({ course_id: "demo", chapters: [chapter("old", "Old chapter", true, ["z"])] }));
  await settleOldResponse();
  secondMe.resolve(errorResponse(401, "not_authenticated", "Sign in to continue."));

  // Back to a visitor, the same caller as the old answer, whose request is still the only answer so far.
  await waitFor(() => expect(chaptersCalls).toBe(2));
  expect(screen.getByRole("status").textContent).toBe("Loading…");
  expect(screen.queryByRole("heading", { level: 2, name: "Old chapter" })).toBeNull();
  secondChapters.resolve(jsonResponse({ course_id: "demo", chapters }));
  expect(await screen.findByRole("heading", { level: 2, name: "First steps" })).toBeTruthy();
  expect(screen.queryByRole("heading", { level: 2, name: "Old chapter" })).toBeNull();
});

it("resumes the first of two in-progress chapters", async () => {
  routes({
    progressBody: progress([
      progressEntry("c1", "in_progress", null, "b"),
      progressEntry("c2", "in_progress", null, "d"),
      progressEntry("c3", "locked", null, null),
    ]),
  });
  renderApp("/courses/demo");

  expect(href(await screen.findByRole("link", { name: "Resume" }))).toBe("/courses/demo/lessons/b");
  expect(screen.getAllByRole("link", { name: "Resume" })).toHaveLength(1);
});

it("says Resume, not Start course, when a lesson was saved but no chapter is passed", async () => {
  routes({
    progressBody: progress([
      progressEntry("c1", "in_progress", null, "b"),
      progressEntry("c2", "locked", null, null),
      progressEntry("c3", "locked", null, null),
    ]),
  });
  renderApp("/courses/demo");

  expect(href(await screen.findByRole("link", { name: "Resume" }))).toBe("/courses/demo/lessons/b");
  expect(screen.queryByRole("link", { name: "Start course" })).toBeNull();
});

it("shows a best score of 0 as Best score: 0/5, not Not attempted", async () => {
  routes({
    progressBody: progress([
      progressEntry("c1", "in_progress", 0, null),
      progressEntry("c2", "locked", null, null),
      progressEntry("c3", "locked", null, null),
    ]),
  });
  renderApp("/courses/demo");

  await screen.findByRole("link", { name: "Start course" });
  expect(card("First steps").getByText("Best score: 0/5")).toBeTruthy();
  expect(card("First steps").queryByText("Not attempted")).toBeNull();
});

it("shows the progress status when it conflicts with the status of the chapters answer", async () => {
  routes({
    progressBody: progress([
      progressEntry("c1", "passed", 4, "b"),
      progressEntry("c2", "in_progress", null, "c"),
      progressEntry("c3", "locked", null, null),
    ]),
    chaptersBody: {
      course_id: "demo",
      chapters: [
        chapter("c1", "First steps", true, ["a", "b"], "locked"),
        chapter("c2", "Middle part", false, ["c", "d"], "passed"),
        chapter("c3", "Last part", false, ["e"], "in_progress"),
      ],
    },
  });
  renderApp("/courses/demo");

  expect(href(await screen.findByRole("link", { name: "Resume" }))).toBe("/courses/demo/lessons/c");
  expect(card("First steps").getByText("Passed")).toBeTruthy();
  expect(card("Middle part").getByText("In progress")).toBeTruthy();
  expect(card("Last part").getByText("Locked")).toBeTruthy();
  expect(screen.queryByText("Passed", { selector: ".status-locked" })).toBeNull();
  expect(card("Last part").queryByRole("link")).toBeNull();
});

it("falls back to the status of the chapters answer, not Locked, for a chapter with no progress entry", async () => {
  routes({
    progressBody: progress([]),
    chaptersBody: {
      course_id: "demo",
      chapters: [
        chapter("c1", "First steps", true, ["a"], "passed"),
        chapter("c2", "Middle part", false, ["c", "d"], "in_progress"),
        chapter("c3", "Last part", false, ["e"], "locked"),
      ],
    },
  });
  renderApp("/courses/demo");

  expect(href(await screen.findByRole("link", { name: "Resume" }))).toBe("/courses/demo/lessons/c");
  expect(card("First steps").getByText("Passed")).toBeTruthy();
  expect(href(card("First steps").getByRole("link", { name: "Retake the quiz" }))).toBe("/courses/demo/chapters/c1/quiz");
  expect(card("Middle part").getByText("In progress")).toBeTruthy();
  expect(href(card("Middle part").getByRole("link", { name: "Take the quiz" }))).toBe("/courses/demo/chapters/c2/quiz");
  expect(card("Last part").getByText("Locked")).toBeTruthy();
});

it("treats a learner's chapter with no progress entry and no status as locked", async () => {
  routes({ progressBody: progress([]) });
  renderApp("/courses/demo");

  await screen.findByRole("heading", { level: 2, name: "Middle part" });
  expect(screen.getAllByText("Locked")).toHaveLength(3);
  expect(screen.queryByRole("link", { name: /quiz/i })).toBeNull();
});

describe("a course id that needs encoding", () => {
  const odd = { ...course, id: "a b/c?d#e" };
  const encoded = "a%20b%2Fc%3Fd%23e";
  const oddChapters = [chapter("c 1", "Odd chapter", true, ["l 1"], "in_progress")];

  function oddRoutes(learner: boolean) {
    apiRoutes({
      ...(learner && {
        "GET /api/auth/me": learnerMe,
        [`GET /api/courses/${encoded}/progress`]: () =>
          jsonResponse({ course_id: odd.id, course_complete: false, chapters: [progressEntry("c 1", "in_progress", null, "l 1")] }),
      }),
      "GET /api/courses": () => jsonResponse({ courses: [odd] }),
      [`GET /api/courses/${encoded}/chapters`]: () => jsonResponse({ course_id: odd.id, chapters: oddChapters }),
    });
  }

  it("encodes it in the lesson, quiz and Resume links of a learner", async () => {
    oddRoutes(true);
    renderApp(`/courses/${encoded}`);

    expect(href(await screen.findByRole("link", { name: "Resume" }))).toBe(`/courses/${encoded}/lessons/l%201`);
    expect(href(screen.getByRole("link", { name: "Lesson l 1" }))).toBe(`/courses/${encoded}/lessons/l%201`);
    expect(href(screen.getByRole("link", { name: "Take the quiz" }))).toBe(`/courses/${encoded}/chapters/c%201/quiz`);
  });

  it("encodes it in the Start reading link and in the next value of the sign-in links of a visitor", async () => {
    oddRoutes(false);
    renderApp(`/courses/${encoded}`);

    expect(href(await screen.findByRole("link", { name: "Start reading" }))).toBe(`/courses/${encoded}/lessons/l%201`);
    // The course path is encoded once for the URL and again as the value of `next`.
    const next = "/courses/a%2520b%252Fc%253Fd%2523e";
    const prompt = within(screen.getByRole("region", { name: /Sign in to save/ }));
    expect(href(prompt.getByRole("link", { name: "Sign in" }))).toBe(`/login?next=${next}`);
    expect(href(prompt.getByRole("link", { name: "Create account" }))).toBe(`/register?next=${next}`);
  });
});

it("shows an error with Try again when a public call answers 401, and keeps it for a visitor", async () => {
  let attempt = 0;
  apiRoutes({
    "GET /api/courses": () => {
      attempt += 1;
      return attempt === 1 ? errorResponse(401, "not_authenticated", "Sign in to continue.") : jsonResponse({ courses: [course] });
    },
    "GET /api/courses/demo/chapters": () => jsonResponse({ course_id: "demo", chapters }),
  });
  const { user } = renderApp("/courses/demo");

  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("Sign in to continue.")).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  await user.click(within(alert).getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("heading", { level: 2, name: "First steps" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("shows no error when a public call answers 401 because the session ended, only the visitor view", async () => {
  let chaptersCalls = 0;
  apiRoutes({
    "GET /api/auth/me": learnerMe,
    "GET /api/courses": () => jsonResponse({ courses: [course] }),
    "GET /api/courses/demo/chapters": () => {
      chaptersCalls += 1;
      return chaptersCalls === 1
        ? errorResponse(401, "not_authenticated", "Sign in to continue.")
        : jsonResponse({ course_id: "demo", chapters });
    },
    "GET /api/courses/demo/progress": () => jsonResponse(progress([progressEntry("c1", "in_progress", null, null)])),
  });
  renderApp("/courses/demo");

  expect(await screen.findByRole("link", { name: "Start reading" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("region", { name: "Sign in to save your progress and take quizzes" })).toBeTruthy();
});
