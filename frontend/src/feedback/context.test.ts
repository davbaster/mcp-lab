import { afterEach, describe, expect, it, vi } from "vitest";
import { appVersion, buildFeedbackRequest, cleanMessage, routeIds, type FeedbackInput } from "./context";
import { installConsoleBuffer, uninstallConsoleBuffer } from "./consoleBuffer";

const ID_PATTERN = /^[a-z0-9-]{1,100}$/;
const WELL_FORMED = /^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/;

afterEach(() => {
  uninstallConsoleBuffer();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function input(patch: Partial<FeedbackInput> = {}): FeedbackInput {
  return { category: "bug", message: "It does not work at all", pathname: "/", questionId: null, aboutQuestion: false, ...patch };
}

describe("routeIds", () => {
  it.each([
    ["/", null, null, null],
    ["/login", null, null, null],
    ["/register", null, null, null],
    ["/courses/mcp", "mcp", null, null],
    ["/courses/mcp/", "mcp", null, null],
    ["/courses/mcp/lessons/intro", "mcp", null, "intro"],
    ["/courses/mcp/chapters/c1/quiz", "mcp", "c1", null],
    ["/courses/typo", "typo", null, null],
  ])("%s gives course %s, chapter %s, lesson %s", (pathname, courseId, chapterId, lessonId) => {
    expect(routeIds(pathname)).toEqual({ courseId, chapterId, lessonId });
  });

  it.each(["/nope", "/courses", "/courses/mcp/other", "/courses/mcp/lessons", "/courses/mcp/chapters/c1", "/courses/mcp/lessons/a/b", "/login/x"])(
    "gives all null for the unknown path %s",
    (pathname) => {
      expect(routeIds(pathname)).toEqual({ courseId: null, chapterId: null, lessonId: null });
    },
  );

  it.each(["/courses/Demo", "/courses/de%20mo", "/courses/a_b", "/courses/%E4%BD%A0", `/courses/${"a".repeat(101)}`])(
    "sends an ID that does not match the server's pattern (%s) as null",
    (pathname) => {
      expect(routeIds(pathname).courseId).toBeNull();
    },
  );

  it("accepts an ID of exactly 100 characters", () => {
    expect(routeIds(`/courses/${"a".repeat(100)}`).courseId).toBe("a".repeat(100));
  });

  it("sends only the bad ID as null when the course is fine", () => {
    expect(routeIds("/courses/mcp/lessons/Bad%20Id")).toEqual({ courseId: "mcp", chapterId: null, lessonId: null });
    expect(routeIds("/courses/mcp/chapters/C1/quiz")).toEqual({ courseId: "mcp", chapterId: null, lessonId: null });
  });

  it("sends the other IDs as null when the course ID is bad", () => {
    expect(routeIds("/courses/Demo/lessons/intro")).toEqual({ courseId: null, chapterId: null, lessonId: null });
    expect(routeIds("/courses/Demo/chapters/c1/quiz")).toEqual({ courseId: null, chapterId: null, lessonId: null });
  });
});

describe("buildFeedbackRequest", () => {
  it("has exactly the fields of FeedbackRequest and its context", () => {
    const request = buildFeedbackRequest(input());

    expect(Object.keys(request).sort()).toEqual(["about_quiz_question", "category", "context", "message"]);
    expect(Object.keys(request.context).sort()).toEqual(
      [
        "app_version",
        "chapter_id",
        "client_time",
        "console_errors",
        "course_id",
        "lesson_id",
        "page_path",
        "question_id",
        "user_agent",
        "viewport",
      ].sort(),
    );
    expect(Object.keys(request.context.viewport).sort()).toEqual(["height", "width"]);
  });

  it("trims the message and keeps the category", () => {
    const request = buildFeedbackRequest(input({ category: "content_error", message: "  \n spaced out text \t " }));

    expect(request.message).toBe("spaced out text");
    expect(request.category).toBe("content_error");
  });

  it("sends a path that starts with // with one leading /", () => {
    expect(buildFeedbackRequest(input({ pathname: "//evil.example/x" })).context.page_path).toBe("/evil.example/x");
    expect(buildFeedbackRequest(input({ pathname: "" })).context.page_path).toBe("/");
  });

  it("cuts a very long path to 2000 characters", () => {
    expect(buildFeedbackRequest(input({ pathname: `/${"a".repeat(5000)}` })).context.page_path).toHaveLength(2000);
  });

  it("gives all-null IDs for the home page, an auth page, and an unknown page", () => {
    for (const pathname of ["/", "/login", "/register", "/nope/at/all"]) {
      const { context } = buildFeedbackRequest(input({ pathname }));
      expect([context.course_id, context.chapter_id, context.lesson_id, context.question_id]).toEqual([null, null, null, null]);
    }
  });

  it("gives the course for a course page, course and lesson for a lesson, course and chapter for a quiz", () => {
    const course = buildFeedbackRequest(input({ pathname: "/courses/mcp" })).context;
    const lesson = buildFeedbackRequest(input({ pathname: "/courses/mcp/lessons/intro" })).context;
    const quiz = buildFeedbackRequest(input({ pathname: "/courses/mcp/chapters/c1/quiz" })).context;

    expect([course.course_id, course.chapter_id, course.lesson_id]).toEqual(["mcp", null, null]);
    expect([lesson.course_id, lesson.chapter_id, lesson.lesson_id]).toEqual(["mcp", null, "intro"]);
    expect([quiz.course_id, quiz.chapter_id, quiz.lesson_id]).toEqual(["mcp", "c1", null]);
  });

  it("puts the question in the context and sets about_quiz_question only when the box is checked", () => {
    const path = "/courses/mcp/chapters/c1/quiz";

    const checked = buildFeedbackRequest(input({ pathname: path, questionId: "q3", aboutQuestion: true }));
    const unchecked = buildFeedbackRequest(input({ pathname: path, questionId: "q3", aboutQuestion: false }));

    expect([checked.about_quiz_question, checked.context.question_id]).toEqual([true, "q3"]);
    expect([unchecked.about_quiz_question, unchecked.context.question_id]).toEqual([false, null]);
  });

  it("never sets about_quiz_question without a question ID", () => {
    const noQuestion = buildFeedbackRequest(input({ pathname: "/courses/mcp/chapters/c1/quiz", questionId: null, aboutQuestion: true }));
    const badQuestion = buildFeedbackRequest(input({ pathname: "/courses/mcp/chapters/c1/quiz", questionId: "Q 3", aboutQuestion: true }));
    const noCourse = buildFeedbackRequest(input({ pathname: "/courses/Demo/chapters/c1/quiz", questionId: "q3", aboutQuestion: true }));

    for (const request of [noQuestion, badQuestion, noCourse]) {
      expect(request.about_quiz_question).toBe(false);
      expect(request.context.question_id).toBeNull();
    }
  });

  it("only sends IDs that match the server's pattern, and nothing else", () => {
    const paths = ["/courses/mcp", "/courses/Demo/lessons/x", "/courses/mcp/lessons/A", "/courses/mcp/chapters/c-1/quiz"];
    for (const pathname of paths) {
      const { context } = buildFeedbackRequest(input({ pathname, questionId: "q-1", aboutQuestion: true }));
      for (const id of [context.course_id, context.chapter_id, context.lesson_id, context.question_id]) {
        if (id !== null && id !== undefined) expect(id).toMatch(ID_PATTERN);
      }
    }
  });

  it("uses the navigator's user agent, cut to 1000 and made safe", () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(`UA\u0000${"x".repeat(2000)}`);

    const { user_agent } = buildFeedbackRequest(input()).context;

    expect(user_agent).toHaveLength(1000);
    expect(user_agent.startsWith("UAxxx")).toBe(true);
  });

  it("sends the viewport as whole numbers of at least 1", () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(390.6);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(0);

    expect(buildFeedbackRequest(input()).context.viewport).toEqual({ width: 390, height: 1 });
  });

  it("caps a very large viewport at the server's 20000, so it cannot cause a 422", () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(20000.9);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(Number.MAX_SAFE_INTEGER);

    expect(buildFeedbackRequest(input()).context.viewport).toEqual({ width: 20000, height: 20000 });
  });

  it("sends the viewport as 1 when the browser reports a value that is not a number", () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(Number.NaN);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(-5);

    expect(buildFeedbackRequest(input()).context.viewport).toEqual({ width: 1, height: 1 });
  });

  it("sends the time as an ISO string in UTC with Z", () => {
    vi.useFakeTimers({ now: new Date("2026-03-04T05:06:07.089Z") });
    try {
      expect(buildFeedbackRequest(input()).context.client_time).toBe("2026-03-04T05:06:07.089Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the console buffer's entries, each made safe and cut to 500", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    installConsoleBuffer();
    console.error("first");
    console.error(`bad\u0000\uD83D${"y".repeat(900)}`);

    const { console_errors } = buildFeedbackRequest(input()).context;

    expect(console_errors[0]).toBe("first");
    expect([...console_errors[1]]).toHaveLength(500);
    expect(console_errors[1]).not.toContain("\u0000");
    expect(WELL_FORMED.test(console_errors[1])).toBe(true);
  });

  it("sends an empty list of console errors when the buffer has none", () => {
    expect(buildFeedbackRequest(input()).context.console_errors).toEqual([]);
  });
});

describe("appVersion", () => {
  it("is the build variable", () => {
    vi.stubEnv("VITE_APP_VERSION", "abc1234");
    expect(appVersion()).toBe("abc1234");
    expect(buildFeedbackRequest(input()).context.app_version).toBe("abc1234");
  });

  it("is dev when the variable is empty or blank", () => {
    vi.stubEnv("VITE_APP_VERSION", "");
    expect(appVersion()).toBe("dev");
    vi.stubEnv("VITE_APP_VERSION", "   ");
    expect(appVersion()).toBe("dev");
  });

  it("is dev when the variable is not set", () => {
    vi.stubEnv("VITE_APP_VERSION", undefined);
    expect(appVersion()).toBe("dev");
  });

  it("is cut to 100 characters", () => {
    vi.stubEnv("VITE_APP_VERSION", "v".repeat(300));
    expect(buildFeedbackRequest(input()).context.app_version).toHaveLength(100);
  });
});

describe("cleanMessage", () => {
  it("removes NULs and lone surrogates before it trims", () => {
    expect(cleanMessage("  \u0000 ab\uD83Dcd  ")).toBe("ab�cd");
  });
});
