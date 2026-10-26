import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { MemoryRouter, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NETWORK_ERROR_MESSAGE, UNEXPECTED_RESPONSE_MESSAGE } from "../api/apiError";
import App from "../App";
import { api } from "../api/client";
import { signInPath } from "../auth/paths";
import { apiRoutes, deferred, type RecordedCall } from "../test/apiRoutes";
import { installDialogShim } from "../test/dialogShim";
import { acceptedResponse, errorResponse, htmlResponse, jsonResponse, mockFetch } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

const FEEDBACK = "POST /api/feedback";
const LONG_ENOUGH = "The code sample in step 2 does not run";

type Handler = NonNullable<Parameters<typeof apiRoutes>[0]>[string];

function setup(overrides: Record<string, Handler> = {}, { learner = true }: { learner?: boolean } = {}) {
  return apiRoutes({
    ...(learner && { "GET /api/auth/me": () => jsonResponse({ username: "ada_l" }) }),
    [FEEDBACK]: () => acceptedResponse(),
    ...overrides,
  });
}

const headerButton = () => screen.getByRole("button", { name: "Send feedback" });
const dialog = () => screen.getByRole("dialog", { name: "Send feedback" });
const inDialog = () => within(dialog());
const queryDialog = () => screen.queryByRole("dialog");
const sendButton = () => inDialog().getByRole("button", { name: /^Send$|^Sending…$/ });
const message = () => inDialog().getByLabelText("Message");
const radio = (name: string) => inDialog().getByRole("radio", { name });
const dialogElement = () => document.querySelector("dialog") as HTMLDialogElement;

/** Renders the app at `url`, waits for the learner's name (or the visitor links), and opens the dialog from the header. */
async function openFromHeader(url = "/courses/demo", options: { learner?: boolean } = {}) {
  const view = renderApp(url);
  if (options.learner !== false) await screen.findByText("ada_l");
  await view.user.click(headerButton());
  return view;
}

async function fillForm(user: UserEvent, category = "Bug", text = LONG_ENOUGH) {
  await user.click(radio(category));
  await user.click(message());
  await user.paste(text);
}

/**
 * jsdom keeps focus on a button that has just been disabled (and cannot blur it), a browser does not.
 * Put focus on Cancel instead, so that "focus goes back to Send" can only come from the code under test.
 */
function leaveFocus() {
  const cancel = inDialog().getByRole("button", { name: "Cancel" });
  cancel.focus();
  expect(document.activeElement).toBe(cancel);
}

async function signInAs(user: UserEvent, username: string) {
  await user.type(await screen.findByLabelText("Username"), username);
  await user.type(screen.getByLabelText("Password"), "a-password");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

/** Two sessions in turn on one page: `who` is the signed-in learner, and a call to /api/health ends the session. */
function sessions(overrides: Record<string, Handler> = {}) {
  let who: string | null = "ada_l";
  setup({
    ...overrides,
    "GET /api/auth/me": () => (who ? jsonResponse({ username: who }) : errorResponse(401, "not_authenticated", "Sign in.")),
    "GET /api/health": () => {
      who = null;
      return errorResponse(401, "not_authenticated", "Sign in.");
    },
    "POST /api/auth/login": (call) => {
      who = (call.body as { username: string }).username;
      return jsonResponse({ username: who });
    },
  });
  /** The session ends, and `username` signs in on the same page. */
  return async (user: UserEvent, currentUrl: () => string, username: string, url: string) => {
    await api.GET("/api/health");
    await user.click(await within(screen.getByRole("banner")).findByRole("link", { name: "Sign in" }));
    await signInAs(user, username);
    await waitFor(() => expect(currentUrl()).toBe(url));
    await screen.findByText(username);
  };
}

function sent(api: ReturnType<typeof apiRoutes>): RecordedCall[] {
  return api.calls(FEEDBACK);
}

type Body = {
  category: string;
  message: string;
  about_quiz_question: boolean;
  context: Record<string, unknown> & { viewport: { width: number; height: number } };
};
const bodyOf = (call: RecordedCall) => call.body as Body;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the header button", () => {
  it("is a native button styled as a secondary button", async () => {
    setup();
    renderApp("/");

    const button = headerButton();
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.className).toBe("button button-secondary");
    expect(within(screen.getByRole("banner")).getByRole("button", { name: "Send feedback" })).toBe(button);
  });

  it("opens the dialog with Enter", async () => {
    setup();
    const { user } = renderApp("/");
    headerButton().focus();

    await user.keyboard("{Enter}");

    expect(dialogElement().open).toBe(true);
  });

  it("opens the dialog with Space", async () => {
    setup();
    const { user } = renderApp("/");
    headerButton().focus();

    await user.keyboard(" ");

    expect(dialogElement().open).toBe(true);
  });

  it("has no dialog content until it is opened", () => {
    setup();
    renderApp("/");

    expect(queryDialog()).toBeNull();
    expect(screen.queryByRole("heading", { name: "Send feedback" })).toBeNull();
  });
});

describe("the dialog", () => {
  it("is a native dialog with a visible heading that names it, outside main", async () => {
    setup();
    await openFromHeader();

    const element = dialogElement();
    expect(element.tagName).toBe("DIALOG");
    expect(element.open).toBe(true);
    const heading = inDialog().getByRole("heading", { level: 2, name: "Send feedback" });
    expect(element.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(screen.getByRole("main").contains(element)).toBe(false);
    // One h1 per page stays.
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("has a visible Cancel button in the form and a Close button in every other state", async () => {
    setup();
    const { user } = await openFromHeader();
    expect(inDialog().getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(inDialog().queryByRole("button", { name: "Close" })).toBeNull();

    await fillForm(user);
    await user.click(sendButton());
    await inDialog().findByText("Thanks – we'll review it");
    expect(inDialog().getByRole("button", { name: "Close" })).toBeTruthy();
    expect(inDialog().queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("puts focus on the first control on open", async () => {
    setup();
    await openFromHeader();

    await waitFor(() => expect(document.activeElement).toBe(radio("Bug")));
  });

  it("moves through its controls in order with Tab", async () => {
    setup();
    const { user } = await openFromHeader();
    await waitFor(() => expect(document.activeElement).toBe(radio("Bug")));

    // A radio group is one Tab stop, so Tab leaves it for the next control.
    await user.tab();
    expect(document.activeElement).toBe(message());
    await user.tab();
    expect(document.activeElement).toBe(sendButton());
    await user.tab();
    expect(document.activeElement).toBe(inDialog().getByRole("button", { name: "Cancel" }));
  });

  it("closes with Escape and gives focus back to the header button", async () => {
    setup();
    const { user } = await openFromHeader();

    await user.keyboard("{Escape}");

    expect(queryDialog()).toBeNull();
    expect(dialogElement().open).toBe(false);
    expect(document.activeElement).toBe(headerButton());
  });

  it("closes with Cancel and gives focus back to the opener", async () => {
    setup();
    const { user } = await openFromHeader();

    await user.click(inDialog().getByRole("button", { name: "Cancel" }));

    expect(queryDialog()).toBeNull();
    expect(document.activeElement).toBe(headerButton());
  });

  it("does not close when the learner clicks outside it", async () => {
    setup();
    const { user } = await openFromHeader();

    // A click on the backdrop lands on the dialog element itself.
    await user.click(dialogElement());
    await user.click(screen.getByRole("main"));

    expect(dialogElement().open).toBe(true);
  });

  it("closes when the route changes, and leaves focus to the new page's heading", async () => {
    setup({}, { learner: false });
    const { user, currentUrl } = await openFromHeader("/courses/demo", { learner: false });

    await user.click(inDialog().getByRole("link", { name: "Sign in" }));

    await waitFor(() => expect(currentUrl()).toBe(signInPath("/courses/demo")));
    // The browser tells the page that the dialog closed in a later task; focus must not move after that.
    await waitFor(() => expect(queryDialog()).toBeNull());
    expect(dialogElement().open).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Sign in" })));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Sign in" }));
  });

  it("closes when the learner goes Back", async () => {
    setup();
    const user = userEvent.setup();
    installDialogShim();
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    function BackButton() {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => void navigate(-1)}>
          Go back
        </button>
      );
    }
    render(
      <MemoryRouter initialEntries={["/", "/courses/demo"]} initialIndex={1}>
        <App />
        <BackButton />
      </MemoryRouter>,
    );
    await screen.findByText("ada_l");
    await user.click(headerButton());
    expect(dialogElement().open).toBe(true);

    await user.click(screen.getByRole("button", { name: "Go back" }));

    await waitFor(() => expect(dialogElement().open).toBe(false));
    cleanup();
  });

  it("writes nothing to storage or cookies, even with a draft", async () => {
    const local = vi.spyOn(Storage.prototype, "setItem");
    setup();
    const { user } = await openFromHeader();
    await fillForm(user);
    await user.click(inDialog().getByRole("button", { name: "Cancel" }));

    expect(local).not.toHaveBeenCalled();
    expect(document.cookie).toBe("");
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("a visitor", () => {
  it("sees the sign-in prompt with a link back to this page, and nothing is sent", async () => {
    const api = setup({}, { learner: false });
    const { user } = await openFromHeader("/courses/demo/lessons/intro?part=2#top", { learner: false });
    await screen.findByRole("link", { name: "Create account" });

    expect(inDialog().getByText("Sign in to send feedback")).toBeTruthy();
    const link = inDialog().getByRole("link", { name: "Sign in" });
    expect(link.getAttribute("href")).toBe(signInPath("/courses/demo/lessons/intro?part=2#top"));
    expect(inDialog().queryByRole("textbox")).toBeNull();
    expect(inDialog().getByRole("button", { name: "Close" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(link));
    await user.keyboard("{Escape}");
    expect(sent(api)).toHaveLength(0);
  });

  it.each(["/login", "/register"])("keeps the page's own next value on %s", async (path) => {
    setup({}, { learner: false });
    await openFromHeader(`${path}?next=/courses/demo/chapters/c1/quiz`, { learner: false });

    expect(inDialog().getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(signInPath("/courses/demo/chapters/c1/quiz"));
  });

  it("gets a plain /login link on /login without a next value", async () => {
    setup({}, { learner: false });
    await openFromHeader("/login", { learner: false });

    expect(inDialog().getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login");
  });

  it("uses the same link as the header's Sign in link", async () => {
    setup({}, { learner: false });
    await openFromHeader("/courses/demo?x=1", { learner: false });

    const header = within(screen.getByRole("banner")).getByRole("link", { name: "Sign in" });
    expect(inDialog().getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(header.getAttribute("href"));
  });
});

describe("while the session is not known yet", () => {
  it("shows Loading…, and becomes the form without closing", async () => {
    const me = deferred<Response>();
    setup({ "GET /api/auth/me": () => me.promise });
    const { user } = renderApp("/courses/demo");

    await user.click(headerButton());

    expect(dialogElement().open).toBe(true);
    expect(inDialog().getByRole("status").textContent).toBe("Loading…");
    expect(inDialog().getByRole("button", { name: "Close" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(inDialog().getByRole("button", { name: "Close" })));

    me.resolve(jsonResponse({ username: "ada_l" }));

    await inDialog().findByRole("group", { name: "Category" });
    expect(dialogElement().open).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(radio("Bug")));
  });

  it("becomes the sign-in prompt, without closing, when the visitor answer arrives", async () => {
    const me = deferred<Response>();
    const api = setup({ "GET /api/auth/me": () => me.promise });
    const { user } = renderApp("/courses/demo");
    await user.click(headerButton());

    me.resolve(errorResponse(401, "not_authenticated", "Sign in to continue."));

    await inDialog().findByText("Sign in to send feedback");
    expect(dialogElement().open).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(inDialog().getByRole("link", { name: "Sign in" })));
    expect(sent(api)).toHaveLength(0);
  });
});

describe("the form", () => {
  it("has four categories in order, none selected, in a fieldset with a legend", async () => {
    setup();
    await openFromHeader();

    const group = inDialog().getByRole("group", { name: "Category" });
    expect(group.tagName).toBe("FIELDSET");
    expect(group.querySelector("legend")?.textContent).toBe("Category");
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.labels?.[0].textContent)).toEqual(["Bug", "Content error", "Confusing explanation", "Suggestion"]);
    expect(radios.map((r) => r.checked)).toEqual([false, false, false, false]);
  });

  it("shows the Content error hint all the time, linked to that radio", async () => {
    setup();
    await openFromHeader();

    const hint = inDialog().getByText("Something is wrong in a lesson, code sample, or quiz");
    expect(radio("Content error").getAttribute("aria-describedby")).toBe(hint.id);
    expect(radio("Bug").hasAttribute("aria-describedby")).toBe(false);
  });

  it("has a Message textarea with a visible label, a counter linked to it, and no maxlength", async () => {
    setup();
    await openFromHeader();

    const box = message();
    expect(box.tagName).toBe("TEXTAREA");
    expect(box.hasAttribute("maxlength")).toBe(false);
    const counter = inDialog().getByText("0 / 2000");
    expect(box.getAttribute("aria-describedby")?.split(" ")).toContain(counter.id);
    expect(counter.closest("[aria-live]")).toBeNull();
    expect(counter.hasAttribute("role")).toBe(false);
  });

  it("counts the trimmed text in code points: an emoji counts once", async () => {
    setup();
    const { user } = await openFromHeader();

    await user.click(message());
    await user.paste("  😀😀a  \n");

    expect(inDialog().getByText("3 / 2000")).toBeTruthy();
  });

  it("says that the page, the browser and recent errors are sent", async () => {
    setup();
    await openFromHeader();

    const note = inDialog().getByText(/page you are on, your browser, and recent errors are sent/i);
    expect(note.className).toContain("hint");
  });

  it("has no checkbox when opened from the header", async () => {
    setup();
    await openFromHeader();

    expect(inDialog().queryByRole("checkbox")).toBeNull();
  });

  it("has one primary button, Send", async () => {
    setup();
    await openFromHeader();

    expect(sendButton().className).toBe("button");
    expect(inDialog().getByRole("button", { name: "Cancel" }).className).toBe("button button-secondary");
  });

  it("adds a new line on Enter in the textarea and does not send", async () => {
    const api = setup();
    const { user } = await openFromHeader();
    await user.click(radio("Bug"));
    await user.click(message());

    await user.keyboard("first line that is long{Enter}second line");

    expect((message() as HTMLTextAreaElement).value).toBe("first line that is long\nsecond line");
    expect(sent(api)).toHaveLength(0);
  });
});

describe("validation", () => {
  it("asks for a category and a message, sends nothing, and focuses the category", async () => {
    const api = setup();
    const { user } = await openFromHeader();

    await user.click(sendButton());

    const group = inDialog().getByRole("group", { name: "Category" });
    const categoryError = inDialog().getByText("Choose a category.");
    expect(group.getAttribute("aria-invalid")).toBe("true");
    expect(group.getAttribute("aria-describedby")).toBe(categoryError.id);
    const messageError = inDialog().getByText("Write at least 10 characters.");
    expect(message().getAttribute("aria-invalid")).toBe("true");
    expect(message().getAttribute("aria-describedby")?.split(" ")).toContain(messageError.id);
    await waitFor(() => expect(document.activeElement).toBe(radio("Bug")));
    expect(sent(api)).toHaveLength(0);
  });

  it("focuses the message when only the message is wrong", async () => {
    const api = setup();
    const { user } = await openFromHeader();
    await user.click(radio("Suggestion"));
    await user.click(message());
    await user.paste("too short");

    await user.click(sendButton());

    expect(inDialog().queryByText("Choose a category.")).toBeNull();
    expect(inDialog().getByText("Write at least 10 characters.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(message()));
    expect(sent(api)).toHaveLength(0);
  });

  it("counts spaces around the text as nothing", async () => {
    const api = setup();
    const { user } = await openFromHeader();
    await user.click(radio("Bug"));
    await user.click(message());
    await user.paste(`     ${"a".repeat(9)}     `);

    await user.click(sendButton());

    expect(inDialog().getByText("Write at least 10 characters.")).toBeTruthy();
    expect(sent(api)).toHaveLength(0);
  });

  it("refuses more than 2000 characters, and the textarea took the paste", async () => {
    const api = setup();
    const { user } = await openFromHeader();
    await user.click(radio("Bug"));
    await user.click(message());
    await user.paste("a".repeat(2001));
    expect(inDialog().getByText("2001 / 2000")).toBeTruthy();

    await user.click(sendButton());

    expect(inDialog().getByText("Use 2000 characters or fewer.")).toBeTruthy();
    expect(sent(api)).toHaveLength(0);
  });

  it("counts an emoji once against the 2000 limit", async () => {
    const api = setup();
    const { user } = await openFromHeader();
    await user.click(radio("Bug"));
    await user.click(message());
    await user.paste("😀".repeat(2000));

    await user.click(sendButton());

    await waitFor(() => expect(sent(api)).toHaveLength(1));
    expect(inDialog().queryByText("Use 2000 characters or fewer.")).toBeNull();
  });

  it("accepts exactly 10 characters", async () => {
    const api = setup();
    const { user } = await openFromHeader();
    await fillForm(user, "Bug", "1234567890");

    await user.click(sendButton());

    await waitFor(() => expect(sent(api)).toHaveLength(1));
  });

  it("clears each error as the field is fixed", async () => {
    setup();
    const { user } = await openFromHeader();
    await user.click(sendButton());
    expect(inDialog().getByText("Choose a category.")).toBeTruthy();

    await user.click(radio("Bug"));
    expect(inDialog().queryByText("Choose a category.")).toBeNull();
    expect(inDialog().getByRole("group", { name: "Category" }).hasAttribute("aria-invalid")).toBe(false);

    await user.click(message());
    await user.paste("short");
    // Still too short: the error stays.
    expect(inDialog().getByText("Write at least 10 characters.")).toBeTruthy();
    await user.paste(" and now it is long enough");
    expect(inDialog().queryByText("Write at least 10 characters.")).toBeNull();
    expect(message().hasAttribute("aria-invalid")).toBe(false);
  });

  it("changes the message error from too short to too long as the text grows", async () => {
    setup();
    const { user } = await openFromHeader();
    await user.click(sendButton());

    await user.click(message());
    await user.paste("a".repeat(2001));

    expect(inDialog().getByText("Use 2000 characters or fewer.")).toBeTruthy();
    expect(inDialog().queryByText("Write at least 10 characters.")).toBeNull();
  });
});

describe("the request", () => {
  it("sends the category, the trimmed message, and the page context", async () => {
    vi.stubEnv("VITE_APP_VERSION", "abc1234");
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(360);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(640);
    const api = setup();
    const { user } = await openFromHeader("/courses/demo/lessons/intro?tab=2#part");
    await fillForm(user, "Content error", `  ${LONG_ENOUGH}  `);

    await user.click(sendButton());

    await waitFor(() => expect(sent(api)).toHaveLength(1));
    const call = sent(api)[0];
    const body = bodyOf(call);
    expect(call.headers["content-type"]).toContain("application/json");
    expect(Object.keys(body).sort()).toEqual(["about_quiz_question", "category", "context", "message"]);
    expect(body.category).toBe("content_error");
    expect(body.message).toBe(LONG_ENOUGH);
    expect(body.about_quiz_question).toBe(false);
    expect(body.context).toMatchObject({
      page_path: "/courses/demo/lessons/intro",
      course_id: "demo",
      chapter_id: null,
      lesson_id: "intro",
      question_id: null,
      app_version: "abc1234",
      user_agent: navigator.userAgent,
      viewport: { width: 360, height: 640 },
      console_errors: [],
    });
    expect(String(body.context.client_time)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(call.text).not.toContain("tab=2");
    expect(call.text).not.toContain("#part");
  });

  it("sends dev as the app version when the build variable is empty", async () => {
    vi.stubEnv("VITE_APP_VERSION", "");
    const api = setup();
    const { user } = await openFromHeader();
    await fillForm(user);

    await user.click(sendButton());

    await waitFor(() => expect(sent(api)).toHaveLength(1));
    expect(bodyOf(sent(api)[0]).context.app_version).toBe("dev");
  });

  it.each([
    ["/", null, null, null],
    ["/courses/demo", "demo", null, null],
    ["/courses/demo/lessons/intro", "demo", null, "intro"],
    ["/courses/demo/chapters/c1/quiz", "demo", "c1", null],
    ["/courses/Demo", null, null, null],
    ["/courses/typo", "typo", null, null],
    ["/no/such/page", null, null, null],
    ["/courses/demo/lessons/Bad%20Id", "demo", null, null],
  ])("sends the IDs of %s as course %s, chapter %s, lesson %s", async (url, course, chapter, lesson) => {
    const api = setup();
    const { user } = await openFromHeader(url);
    await fillForm(user);

    await user.click(sendButton());

    await waitFor(() => expect(sent(api)).toHaveLength(1));
    const { context } = bodyOf(sent(api)[0]);
    expect([context.course_id, context.chapter_id, context.lesson_id, context.question_id]).toEqual([course, chapter, lesson, null]);
  });

  it("sends a page path that matches the page, with no query or hash, from the not-found page", async () => {
    const api = setup();
    const { user } = await openFromHeader("/Nope?x=1#y");
    await fillForm(user);

    await user.click(sendButton());

    await waitFor(() => expect(sent(api)).toHaveLength(1));
    expect(bodyOf(sent(api)[0]).context.page_path).toBe("/Nope");
  });

  it("sends the console buffer's entries and nothing from the learner's own console calls beyond them", async () => {
    const { installConsoleBuffer, uninstallConsoleBuffer } = await import("./consoleBuffer");
    vi.spyOn(console, "error").mockImplementation(() => {});
    installConsoleBuffer();
    try {
      const api = setup();
      const { user } = await openFromHeader();
      console.error("lesson failed to load", new Error("bad json"));
      await fillForm(user);

      await user.click(sendButton());

      await waitFor(() => expect(sent(api)).toHaveLength(1));
      expect(bodyOf(sent(api)[0]).context.console_errors).toEqual(["lesson failed to load Error: bad json"]);
    } finally {
      uninstallConsoleBuffer();
    }
  });
});

describe("sending", () => {
  it("disables Send and reads Sending… while the request runs, and sends one request for a double click", async () => {
    const answer = deferred<Response>();
    const api = setup({ [FEEDBACK]: () => answer.promise });
    const { user } = await openFromHeader();
    await fillForm(user);

    await user.dblClick(sendButton());

    expect(sendButton().textContent).toBe("Sending…");
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    expect(sent(api)).toHaveLength(1);
    // Enter in the form while it is in flight sends nothing more.
    fireEvent.submit(sendButton().closest("form") as HTMLFormElement);
    expect(sent(api)).toHaveLength(1);
    answer.resolve(acceptedResponse());
    await inDialog().findByText("Thanks – we'll review it");
    expect(sent(api)).toHaveLength(1);
  });
});

describe("sending twice at once", () => {
  it("sends one request when Send is submitted twice before React has shown Sending…", async () => {
    const answer = deferred<Response>();
    const api = setup({ [FEEDBACK]: () => answer.promise });
    const { user } = await openFromHeader();
    await fillForm(user);
    const form = sendButton().closest("form") as HTMLFormElement;

    // Both submits run with the same render, so only the provider's own guard can stop the second.
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });

    await waitFor(() => expect(sent(api)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent(api)).toHaveLength(1);
    answer.resolve(acceptedResponse());
    await inDialog().findByText("Thanks – we'll review it");
  });
});

describe("an answer that arrives after the learner moved on", () => {
  const ANSWERS: [string, () => Response][] = [
    ["a success", () => acceptedResponse()],
    ["a 429", () => errorResponse(429, "feedback_limit_reached", "That is enough for today.")],
    ["a 401", () => errorResponse(401, "other_code", "Sign in.")],
  ];

  it.each(ANSWERS)("does not show %s from the first page on the next page, and keeps that page's draft", async (_name, answerWith) => {
    const answer = deferred<Response>();
    const api = setup({ [FEEDBACK]: () => answer.promise });
    const { user } = await openFromHeader("/courses/demo");
    await fillForm(user);
    await user.click(sendButton());
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("link", { name: "Courses" }));
    await screen.findByRole("heading", { level: 1, name: "Courses" });

    await user.click(headerButton());
    // The send from the other page is not this page's: nothing is pending here.
    expect(sendButton().textContent).toBe("Send");
    expect((sendButton() as HTMLButtonElement).disabled).toBe(false);
    await user.click(radio("Suggestion"));
    await user.click(message());
    await user.paste("A draft written on this page");
    answer.resolve(answerWith());
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(sent(api)).toHaveLength(1);
    expect(inDialog().queryByText("Thanks – we'll review it")).toBeNull();
    expect(inDialog().queryByRole("alert")).toBeNull();
    expect(inDialog().queryByText("Sign in to send feedback")).toBeNull();
    expect((message() as HTMLTextAreaElement).value).toBe("A draft written on this page");
    expect((radio("Suggestion") as HTMLInputElement).checked).toBe(true);
    // Nor does it show up when the dialog is opened again here.
    await user.keyboard("{Escape}");
    await user.click(headerButton());
    expect(inDialog().queryByText("Thanks – we'll review it")).toBeNull();
    expect(inDialog().queryByRole("alert")).toBeNull();
    expect((message() as HTMLTextAreaElement).value).toBe("A draft written on this page");
  });

  it("lets the learner send from the next page while the first send is still pending", async () => {
    const first = deferred<Response>();
    let calls = 0;
    const api = setup({ [FEEDBACK]: () => (++calls === 1 ? first.promise : acceptedResponse()) });
    const { user } = await openFromHeader("/courses/demo");
    await fillForm(user);
    await user.click(sendButton());
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("link", { name: "Courses" }));
    await screen.findByRole("heading", { level: 1, name: "Courses" });

    await user.click(headerButton());
    await fillForm(user, "Suggestion", "A second piece of feedback");
    await user.click(sendButton());

    await inDialog().findByText("Thanks – we'll review it");
    expect(sent(api)).toHaveLength(2);
    // The first answer does not take the thanks away, or turn it into an error.
    first.resolve(errorResponse(500, "internal_error", "Broke."));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(inDialog().getByText("Thanks – we'll review it")).toBeTruthy();
    expect(inDialog().queryByRole("alert")).toBeNull();
  });

  it("does not show the answer for one learner to the next learner on the same page", async () => {
    const answer = deferred<Response>();
    const switchTo = sessions({ [FEEDBACK]: () => answer.promise });
    const { user, currentUrl } = await openFromHeader("/courses/demo");
    await fillForm(user);
    await user.click(sendButton());
    await user.keyboard("{Escape}");
    await switchTo(user, currentUrl, "bob_k", "/courses/demo");

    await user.click(headerButton());
    expect(sendButton().textContent).toBe("Send");
    answer.resolve(acceptedResponse());
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(inDialog().queryByText("Thanks – we'll review it")).toBeNull();
    expect(inDialog().getByRole("group", { name: "Category" })).toBeTruthy();
  });
});

describe("after a send", () => {
  it("thanks the learner on a 202 with no body, with focus on the message, and shows nothing more", async () => {
    setup();
    const { user } = await openFromHeader();
    await fillForm(user);

    await user.click(sendButton());

    const thanks = await inDialog().findByText("Thanks – we'll review it");
    expect(thanks.getAttribute("role")).toBe("status");
    await waitFor(() => expect(document.activeElement).toBe(thanks));
    expect(inDialog().getByRole("button", { name: "Close" })).toBeTruthy();
    expect(inDialog().queryByRole("textbox")).toBeNull();
    expect(inDialog().queryByRole("radio")).toBeNull();
    expect(inDialog().getByRole("heading", { name: "Send feedback" })).toBeTruthy();
    // Nothing but the heading, the thanks and Close: no ID, status or count of what is left.
    expect(dialog().textContent).toBe("Send feedbackThanks – we'll review itClose");
    expect(thanks.textContent).toContain("\u2013");
  });

  it("closes with Close and gives focus back to the header button", async () => {
    setup();
    const { user } = await openFromHeader();
    await fillForm(user);
    await user.click(sendButton());

    await user.click(await inDialog().findByRole("button", { name: "Close" }));

    expect(queryDialog()).toBeNull();
    expect(document.activeElement).toBe(headerButton());
  });

  it("clears the form after a successful send, so the next time starts empty", async () => {
    setup();
    const { user } = await openFromHeader();
    await fillForm(user, "Suggestion");
    await user.click(sendButton());
    await user.click(await inDialog().findByRole("button", { name: "Close" }));

    await user.click(headerButton());

    expect((message() as HTMLTextAreaElement).value).toBe("");
    expect((radio("Suggestion") as HTMLInputElement).checked).toBe(false);
    expect(inDialog().queryByText("Thanks – we'll review it")).toBeNull();
  });

  it("shows the server's message word for word on a 429, keeps the draft, and puts focus on Send", async () => {
    const limit = "You have sent 5 items today. Try again after 00:00 UTC (2026-03-05T00:00:00Z).";
    const answer = deferred<Response>();
    setup({ [FEEDBACK]: () => answer.promise });
    const { user } = await openFromHeader();
    await fillForm(user, "Confusing explanation");

    await user.click(sendButton());
    leaveFocus();
    answer.resolve(errorResponse(429, "feedback_limit_reached", limit));

    const alert = await inDialog().findByRole("alert");
    expect(alert.textContent).toBe(limit);
    expect((message() as HTMLTextAreaElement).value).toBe(LONG_ENOUGH);
    expect((radio("Confusing explanation") as HTMLInputElement).checked).toBe(true);
    expect((sendButton() as HTMLButtonElement).disabled).toBe(false);
    expect(sendButton().textContent).toBe("Send");
    await waitFor(() => expect(document.activeElement).toBe(sendButton()));
    // The box is above the form.
    expect(alert.compareDocumentPosition(inDialog().getByRole("group", { name: "Category" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the server's message on a 422, such as an unknown course, and keeps the text", async () => {
    setup({ [FEEDBACK]: () => errorResponse(422, "validation_error", "Unknown course") });
    const { user } = await openFromHeader("/courses/typo");
    await fillForm(user);

    await user.click(sendButton());

    expect((await inDialog().findByRole("alert")).textContent).toBe("Unknown course");
    expect((message() as HTMLTextAreaElement).value).toBe(LONG_ENOUGH);
  });

  it("shows the message on a 500, then lets the learner send again and succeed", async () => {
    let calls = 0;
    const api = setup({
      [FEEDBACK]: () => (++calls === 1 ? errorResponse(500, "internal_error", "Something broke on our side.") : acceptedResponse()),
    });
    const { user } = await openFromHeader();
    await fillForm(user);
    await user.click(sendButton());
    expect((await inDialog().findByRole("alert")).textContent).toBe("Something broke on our side.");

    await user.click(sendButton());

    await inDialog().findByText("Thanks – we'll review it");
    expect(sent(api)).toHaveLength(2);
    expect(inDialog().queryByRole("alert")).toBeNull();
  });

  it("clears the error box when the next send starts", async () => {
    const second = deferred<Response>();
    let calls = 0;
    setup({ [FEEDBACK]: () => (++calls === 1 ? errorResponse(500, "internal_error", "Broke.") : second.promise) });
    const { user } = await openFromHeader();
    await fillForm(user);
    await user.click(sendButton());
    await inDialog().findByRole("alert");

    await user.click(sendButton());

    expect(inDialog().queryByRole("alert")).toBeNull();
    second.resolve(acceptedResponse());
    await inDialog().findByText("Thanks – we'll review it");
  });

  it("shows a fixed message for a 502 HTML page, never its text, and keeps the draft", async () => {
    setup({ [FEEDBACK]: () => htmlResponse(502, "<html><body>Bad gateway SENTINEL-HTML</body></html>") });
    const { user } = await openFromHeader();
    await fillForm(user);

    await user.click(sendButton());

    const alert = await inDialog().findByRole("alert");
    expect(alert.textContent).toBe(UNEXPECTED_RESPONSE_MESSAGE);
    expect(dialog().textContent).not.toContain("SENTINEL-HTML");
    expect((message() as HTMLTextAreaElement).value).toBe(LONG_ENOUGH);
  });

  it("shows the network message when the request cannot be made, and keeps the draft", async () => {
    const api = setup();
    const { user } = await openFromHeader();
    await fillForm(user);
    const offline = deferred<void>();
    mockFetch(async () => {
      await offline.promise;
      throw new TypeError("Failed to fetch");
    });

    await user.click(sendButton());
    leaveFocus();
    offline.resolve();

    expect((await inDialog().findByRole("alert")).textContent).toBe(NETWORK_ERROR_MESSAGE);
    expect((message() as HTMLTextAreaElement).value).toBe(LONG_ENOUGH);
    expect((radio("Bug") as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(sendButton()));
    expect(sent(api)).toHaveLength(0);
  });

  it("does not use the thanks text for a failure", async () => {
    setup({ [FEEDBACK]: () => errorResponse(500, "internal_error", "Nope.") });
    const { user } = await openFromHeader();
    await fillForm(user);

    await user.click(sendButton());

    await inDialog().findByRole("alert");
    expect(inDialog().queryByText("Thanks – we'll review it")).toBeNull();
  });
});

describe("a 401", () => {
  it.each(["not_authenticated", "session_expired"])("switches to the sign-in prompt for the code %s and keeps the draft", async (code) => {
    setup({ [FEEDBACK]: () => errorResponse(401, code, "Sign in to continue.") });
    const { user } = await openFromHeader("/courses/demo");
    await fillForm(user, "Suggestion");

    await user.click(sendButton());

    await inDialog().findByText("Sign in to send feedback");
    expect(inDialog().getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(signInPath("/courses/demo"));
    expect(inDialog().queryByRole("textbox")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(inDialog().getByRole("link", { name: "Sign in" })));
  });

  it("gives the same learner the draft back after signing in and returning to the same page", async () => {
    let session = true;
    setup({
      "GET /api/auth/me": () => (session ? jsonResponse({ username: "ada_l" }) : errorResponse(401, "not_authenticated", "Sign in.")),
      [FEEDBACK]: () => {
        session = false;
        return errorResponse(401, "not_authenticated", "Sign in to continue.");
      },
      "POST /api/auth/login": () => jsonResponse({ username: "ada_l" }),
    });
    const { user, currentUrl } = await openFromHeader("/courses/demo");
    await fillForm(user, "Content error");
    await user.click(sendButton());
    await user.click(await inDialog().findByRole("link", { name: "Sign in" }));
    await signInAs(user, "ada_l");
    await waitFor(() => expect(currentUrl()).toBe("/courses/demo"));
    await screen.findByText("ada_l");

    await user.click(headerButton());

    expect((message() as HTMLTextAreaElement).value).toBe(LONG_ENOUGH);
    expect((radio("Content error") as HTMLInputElement).checked).toBe(true);
  });

  it("drops the draft when another learner signs in on the same page", async () => {
    let session = true;
    setup({
      "GET /api/auth/me": () => (session ? jsonResponse({ username: "ada_l" }) : errorResponse(401, "not_authenticated", "Sign in.")),
      [FEEDBACK]: () => {
        session = false;
        return errorResponse(401, "not_authenticated", "Sign in to continue.");
      },
      "POST /api/auth/login": () => jsonResponse({ username: "bob_k" }),
    });
    const { user, currentUrl } = await openFromHeader("/courses/demo");
    await fillForm(user, "Content error");
    await user.click(sendButton());
    await user.click(await inDialog().findByRole("link", { name: "Sign in" }));
    await signInAs(user, "bob_k");
    await waitFor(() => expect(currentUrl()).toBe("/courses/demo"));
    await screen.findByText("bob_k");

    await user.click(headerButton());

    expect((message() as HTMLTextAreaElement).value).toBe("");
    expect((radio("Content error") as HTMLInputElement).checked).toBe(false);
  });

  it("does not give the first learner's draft back after a second learner opened the form and the first signed in again", async () => {
    const switchTo = sessions();
    const { user, currentUrl } = await openFromHeader("/courses/demo");
    await fillForm(user, "Content error");
    await user.keyboard("{Escape}");

    await switchTo(user, currentUrl, "bob_k", "/courses/demo");
    await user.click(headerButton());
    // The second learner only looks at the form, and writes nothing.
    expect((message() as HTMLTextAreaElement).value).toBe("");
    await user.keyboard("{Escape}");
    await switchTo(user, currentUrl, "ada_l", "/courses/demo");
    await user.click(headerButton());

    expect((message() as HTMLTextAreaElement).value).toBe("");
    expect((radio("Content error") as HTMLInputElement).checked).toBe(false);
  });

  it("switches an open form to the prompt when the session ends elsewhere, with the draft kept", async () => {
    let session = true;
    const fake = setup({
      "GET /api/auth/me": () => (session ? jsonResponse({ username: "ada_l" }) : errorResponse(401, "not_authenticated", "Sign in.")),
      "GET /api/courses/demo/progress": () => {
        session = false;
        return errorResponse(401, "not_authenticated", "Sign in.");
      },
    });
    const { user } = await openFromHeader("/");
    await fillForm(user);
    expect(sent(fake)).toHaveLength(0);

    // Some other call finds out that the session is over.
    await api.GET("/api/courses/{course_id}/progress", { params: { path: { course_id: "demo" } } });

    await inDialog().findByText("Sign in to send feedback");
    expect(dialogElement().open).toBe(true);
    await user.click(inDialog().getByRole("button", { name: "Close" }));
    expect(document.activeElement).toBe(headerButton());
  });
});

describe("the draft", () => {
  it("is still there when the dialog is opened again on the same page", async () => {
    setup();
    const { user } = await openFromHeader();
    await fillForm(user, "Confusing explanation", "My draft that is long enough");
    await user.keyboard("{Escape}");

    await user.click(headerButton());

    expect((message() as HTMLTextAreaElement).value).toBe("My draft that is long enough");
    expect((radio("Confusing explanation") as HTMLInputElement).checked).toBe(true);
  });

  it("is still there after Cancel", async () => {
    setup();
    const { user } = await openFromHeader();
    await fillForm(user);
    await user.click(inDialog().getByRole("button", { name: "Cancel" }));

    await user.click(headerButton());

    expect((message() as HTMLTextAreaElement).value).toBe(LONG_ENOUGH);
  });

  it("is dropped when the dialog is opened on another page", async () => {
    setup();
    const { user } = await openFromHeader("/courses/demo");
    await fillForm(user);
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("link", { name: "Courses" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Courses" })).toBeTruthy());
    await user.click(headerButton());

    expect((message() as HTMLTextAreaElement).value).toBe("");
    expect((radio("Bug") as HTMLInputElement).checked).toBe(false);
  });

  it("is kept when only the query changes, because the page is the same", async () => {
    setup();
    const { user } = await openFromHeader("/courses/demo?tab=1");
    await fillForm(user);
    await user.keyboard("{Escape}");

    await user.click(headerButton());

    expect((message() as HTMLTextAreaElement).value).toBe(LONG_ENOUGH);
  });
});

describe("closing during a request", () => {
  it("does not cancel the request, and shows the thanks when the dialog is opened again", async () => {
    const answer = deferred<Response>();
    const api = setup({ [FEEDBACK]: () => answer.promise });
    const { user } = await openFromHeader();
    await fillForm(user);
    await user.click(sendButton());

    await user.keyboard("{Escape}");
    answer.resolve(acceptedResponse());
    await waitFor(() => expect(sent(api)).toHaveLength(1));
    await user.click(headerButton());

    const thanks = await inDialog().findByText("Thanks – we'll review it");
    await waitFor(() => expect(document.activeElement).toBe(thanks));
    // The draft went with the successful send.
    await user.click(inDialog().getByRole("button", { name: "Close" }));
    await user.click(headerButton());
    expect((message() as HTMLTextAreaElement).value).toBe("");
  });

  it("shows the error with the text kept when the dialog is opened again", async () => {
    const answer = deferred<Response>();
    setup({ [FEEDBACK]: () => answer.promise });
    const { user } = await openFromHeader();
    await fillForm(user);
    await user.click(sendButton());
    await user.keyboard("{Escape}");

    answer.resolve(errorResponse(429, "feedback_limit_reached", "That is enough for today."));
    await waitFor(() => expect(queryDialog()).toBeNull());
    await user.click(headerButton());

    expect((await inDialog().findByRole("alert")).textContent).toBe("That is enough for today.");
    expect((message() as HTMLTextAreaElement).value).toBe(LONG_ENOUGH);
    expect((sendButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows Sending… when the dialog is opened again before the answer", async () => {
    const answer = deferred<Response>();
    const api = setup({ [FEEDBACK]: () => answer.promise });
    const { user } = await openFromHeader();
    await fillForm(user);
    await user.click(sendButton());
    await user.keyboard("{Escape}");

    await user.click(headerButton());

    expect(sendButton().textContent).toBe("Sending…");
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    expect(sent(api)).toHaveLength(1);
    answer.resolve(acceptedResponse());
    await inDialog().findByText("Thanks – we'll review it");
  });

  it("forgets an outcome the learner has seen", async () => {
    setup({ [FEEDBACK]: () => errorResponse(500, "internal_error", "Broke.") });
    const { user } = await openFromHeader();
    await fillForm(user);
    await user.click(sendButton());
    await inDialog().findByRole("alert");
    await user.keyboard("{Escape}");

    await user.click(headerButton());

    expect(inDialog().queryByRole("alert")).toBeNull();
    expect((message() as HTMLTextAreaElement).value).toBe(LONG_ENOUGH);
  });
});
