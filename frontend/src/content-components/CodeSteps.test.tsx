import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORK_ERROR_MESSAGE, UNEXPECTED_RESPONSE_MESSAGE } from "../api/apiError";
import { apiRoutes, deferred } from "../test/apiRoutes";
import { errorResponse, htmlResponse, jsonResponse } from "../test/mockApi";
import { component, paragraph, renderTree, spyOnConsole, tab, text } from "../test/renderTree";
import { splitLines } from "./codeLines";
import golden from "./fixtures/chapter-code.response.json";
import { highlight, MAX_HIGHLIGHT_CHARS } from "./highlighter";

// The real highlighter is tested in highlighter.test.ts. Here it is a stand-in that colors every
// line, so these tests are fast and can hold the colors back.
vi.mock("./highlighter", async (importOriginal) => ({ ...(await importOriginal<typeof import("./highlighter")>()), highlight: vi.fn() }));

const IDS = { courseId: "sample-course", chapterId: "01-first-steps" };
const CODE = "GET /api/courses/sample-course/chapters/01-first-steps/code";

type Chapter = typeof golden;
const chapter = (change: (data: Chapter) => void = () => {}): Chapter => {
  const data = structuredClone(golden);
  change(data);
  return data;
};
type FileData = Chapter["steps"][number]["files"][number];
const file = (path: string, content: string, status = "added"): FileData => ({ path, status, content, changed_lines: [] }) as FileData;
/** A chapter with one step holding these files. */
const oneStep = (...files: FileData[]) => chapter((data) => (data.steps = [{ step: 1, files }]));

function serve(body: unknown = golden) {
  return apiRoutes({ [CODE]: () => jsonResponse(body) });
}

const steps = (props: Record<string, unknown>) => component("CodeSteps", props);
function show(nodes: unknown[], options: Parameters<typeof renderTree>[1] = {}) {
  return renderTree(nodes, { lesson: IDS, ...options });
}
const tabs = () => screen.getAllByRole("tab");
const tabNames = () => tabs().map((t) => t.textContent);
const selectedTab = () => tabs().find((t) => t.getAttribute("aria-selected") === "true");
const codeText = (root: ParentNode = document) =>
  Array.from(root.querySelectorAll(".code-line-text"))
    .map((line) => line.textContent)
    .join("");

/** A stand-in highlighter: every line is one keyword token. */
function colorEveryLine() {
  vi.mocked(highlight).mockImplementation(async (content) => splitLines(content).map((line) => [{ text: line.text, className: "code-token-keyword" }]));
}

beforeEach(() => {
  vi.mocked(highlight).mockReset();
  colorEveryLine();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getting the data", () => {
  it("requests the code of the lesson's chapter through the client and shows the step named in the prop", async () => {
    const api = serve();
    show([steps({ step: "2" })]);

    expect(await screen.findByRole("tablist")).toBeTruthy();
    expect(api.calls(CODE)).toHaveLength(1);
    expect(api.calls(CODE)[0].method).toBe("GET");
    expect(api.calls()).toHaveLength(1);
    expect(tabNames()).toEqual(["helper.py", "main.py", "pkg/__init__.py", "pkg/util.py", "settings.txt"]);
  });

  it("uses the course and chapter IDs of the lesson, not the ones in the answer", async () => {
    const api = apiRoutes({ "GET /api/courses/other%20course/chapters/c%2F2/code": () => jsonResponse(golden) });
    show([steps({ step: "1" })], { lesson: { courseId: "other course", chapterId: "c/2" } });

    expect(await screen.findByRole("tablist")).toBeTruthy();
    expect(api.calls()).toHaveLength(1);
  });

  it("sends no /code request and loads no highlighter for a lesson without CodeSteps", async () => {
    const api = serve();
    show([paragraph(text("Just text.")), component("Callout", { type: "tip" }, [paragraph(text("A tip."))])]);

    expect(screen.getByText("Just text.")).toBeTruthy();
    await new Promise((done) => setTimeout(done, 20));
    expect(api.calls()).toHaveLength(0);
    expect(highlight).not.toHaveBeenCalled();
  });

  const threeViewers = () => [
    steps({ step: "1" }),
    component("Tabs", {}, [tab("One", paragraph(text("first tab"))), tab("Two", steps({ step: "2" }))]),
    component("Callout", { type: "tip" }, [steps({ step: "3" })]),
  ];

  it.each([false, true])("sends one request for three viewers, one in an unselected tab and one in a callout (strict: %s)", async (strict) => {
    const api = serve();
    show(threeViewers(), { strict });

    await waitFor(() => expect(document.querySelectorAll(".code-steps [role=tablist]")).toHaveLength(3));
    expect(api.calls(CODE)).toHaveLength(1);
  });

  it("shows each viewer's own step and keeps its own selected tab", async () => {
    serve();
    const { user, container } = show(threeViewers());
    await waitFor(() => expect(container.querySelectorAll(".code-steps [role=tablist]")).toHaveLength(3));

    const lists = Array.from(container.querySelectorAll<HTMLElement>(".code-steps [role=tablist]"));
    expect(lists.map((list) => list.getAttribute("aria-label"))).toEqual(["Files in step 1", "Files in step 2", "Files in step 3"]);
    expect(Array.from(lists[0].querySelectorAll("[role=tab]")).map((t) => t.textContent)).toEqual(["helper.py", "main.py", "settings.txt"]);
    expect(Array.from(lists[2].querySelectorAll("[role=tab]")).map((t) => t.textContent)).toEqual(["main.py", "pkg/__init__.py", "pkg/util.py", "settings.txt"]);

    await user.click(within(lists[0]).getByRole("tab", { name: "settings.txt" }));
    await user.click(within(lists[2]).getByRole("tab", { name: "pkg/util.py" }));

    expect(within(lists[0]).getByRole("tab", { name: "settings.txt" }).getAttribute("aria-selected")).toBe("true");
    expect(within(lists[2]).getByRole("tab", { name: "pkg/util.py" }).getAttribute("aria-selected")).toBe("true");
    // The viewer in the hidden tab still has its first file selected.
    expect(within(lists[1], ).getAllByRole("tab", { hidden: true })[0].getAttribute("aria-selected")).toBe("true");
  });

  it("does not keep the code after the lesson view: a new view sends a new request", async () => {
    const api = serve();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const first = show([steps({ step: "1" })]);
    expect(await screen.findByRole("tablist")).toBeTruthy();
    expect(api.calls(CODE)).toHaveLength(1);

    first.unmount();
    show([steps({ step: "1" })]);
    expect(await screen.findByRole("tablist")).toBeTruthy();

    expect(api.calls(CODE)).toHaveLength(2);
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("shows Loading code… in a status box while the request is out", async () => {
    const pending = deferred<Response>();
    apiRoutes({ [CODE]: () => pending.promise });
    const { container } = show([steps({ step: "1" })]);

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("Loading code…");
    expect(status.className).toBe("code-steps-loading");
    expect(container.querySelector(".code-steps")).toBeTruthy();
    pending.resolve(jsonResponse(golden));
    expect(await screen.findByRole("tablist")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("a failed request", () => {
  const failures: [string, () => Response | Promise<Response>, string][] = [
    ["a 401", () => errorResponse(401, "not_authenticated", "Sign in to read this."), "Sign in to read this."],
    ["a 403", () => errorResponse(403, "chapter_locked", "This chapter is locked."), "This chapter is locked."],
    ["a 404", () => errorResponse(404, "code_not_found", "This chapter has no code."), "This chapter has no code."],
    ["a 500", () => errorResponse(500, "internal_error", "Something broke on our side."), "Something broke on our side."],
    ["a network error", () => Promise.reject(new TypeError("Failed to fetch")), NETWORK_ERROR_MESSAGE],
    ["an HTML 502 page", () => htmlResponse(502), UNEXPECTED_RESPONSE_MESSAGE],
    ["a 200 that is not the expected shape", () => jsonResponse({ steps: "no", zip: null }), UNEXPECTED_RESPONSE_MESSAGE],
    ["a 200 with a status that is not known", () => jsonResponse(chapter((d) => ((d.steps[0].files[0] as { status: string }).status = "renamed"))), UNEXPECTED_RESPONSE_MESSAGE],
  ];

  it.each(failures)("shows the message and Try again after %s", async (_name, answer, message) => {
    const log = spyOnConsole();
    apiRoutes({ [CODE]: answer });
    show([steps({ step: "1" })]);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(message);
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("asks again on Try again, shows the code, and moves focus to the component's own box", async () => {
    let attempts = 0;
    const api = apiRoutes({
      [CODE]: () => (++attempts === 1 ? errorResponse(500, "internal_error", "Not now.") : jsonResponse(golden)),
    });
    const { user, container } = show([steps({ step: "1" })]);

    await user.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("tablist")).toBeTruthy();
    expect(api.calls(CODE)).toHaveLength(2);
    const box = container.querySelector<HTMLElement>(".code-steps");
    expect(box?.getAttribute("tabindex")).toBe("-1");
    await waitFor(() => expect(document.activeElement).toBe(box));
  });

  it("shows the error again when Try again fails again", async () => {
    const api = apiRoutes({ [CODE]: () => errorResponse(500, "internal_error", "Still broken.") });
    const { user } = show([steps({ step: "1" })]);

    await user.click(await screen.findByRole("button", { name: "Try again" }));

    await waitFor(() => expect(api.calls(CODE)).toHaveLength(2));
    expect((await screen.findByRole("alert")).textContent).toContain("Still broken.");
  });

  it("shows the failure in every viewer, and one Try again refreshes all of them with one request", async () => {
    let attempts = 0;
    const api = apiRoutes({
      [CODE]: () => (++attempts === 1 ? errorResponse(500, "internal_error", "Not now.") : jsonResponse(golden)),
    });
    const { user, container } = show([steps({ step: "1" }), steps({ step: "2" }), steps({ step: "3" })]);

    expect(await screen.findAllByRole("alert")).toHaveLength(3);
    expect(api.calls(CODE)).toHaveLength(1);

    await user.click(screen.getAllByRole("button", { name: "Try again" })[1]);

    await waitFor(() => expect(container.querySelectorAll("[role=tablist]")).toHaveLength(3));
    expect(api.calls(CODE)).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("a step that cannot be shown", () => {
  it("shows the code-step box, logs one error that names CodeSteps and the step, and keeps the rest of the lesson", async () => {
    const log = spyOnConsole();
    const api = serve();
    show([steps({ step: "9" }), paragraph(text("After the viewer."))]);

    expect(await screen.findByText("This code step can't be shown")).toBeTruthy();
    expect(screen.getByText("After the viewer.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    // The error is logged by an effect, which may run just after the box is on the page.
    await waitFor(() => expect(log.error).toHaveBeenCalledTimes(1));
    expect(String(log.error.mock.calls[0][0])).toContain("CodeSteps");
    expect(String(log.error.mock.calls[0][0])).toContain("step 9");
    expect(api.calls(CODE)).toHaveLength(1);
  });

  it("shows it for a step with no file left to show (every file deleted)", async () => {
    const log = spyOnConsole();
    serve(chapter((d) => (d.steps[0].files = [file("gone.py", "", "deleted")])));
    show([steps({ step: "1" }), paragraph(text("After the viewer."))]);

    expect(await screen.findByText("This code step can't be shown")).toBeTruthy();
    expect(screen.getByText("After the viewer.")).toBeTruthy();
    await waitFor(() => expect(log.error).toHaveBeenCalledTimes(1));
  });

  it("shows it for a step with no files at all", async () => {
    spyOnConsole();
    serve(chapter((d) => (d.steps[0].files = [])));
    show([steps({ step: "1" })]);
    expect(await screen.findByText("This code step can't be shown")).toBeTruthy();
  });

  it("logs once under StrictMode", async () => {
    const log = spyOnConsole();
    serve();
    show([steps({ step: "9" })], { strict: true });
    expect(await screen.findByText("This code step can't be shown")).toBeTruthy();
    await waitFor(() => expect(log.error).toHaveBeenCalledTimes(1));
    await new Promise((done) => setTimeout(done, 20));
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["0", { step: "0" }],
    ["01", { step: "01" }],
    ["1.5", { step: "1.5" }],
    ["abc", { step: "abc" }],
    ["too large to be a safe integer", { step: "9007199254740993" }],
    ["a number, not a string", { step: 1 }],
    ["missing", {}],
    ["an empty file", { step: "1", file: "" }],
    ["a file that is not a string", { step: "1", file: 5 }],
  ])("shows the standard box and sends no request for a step prop that is %s", async (_name, props) => {
    const log = spyOnConsole();
    const api = serve();
    show([component("CodeSteps", props), paragraph(text("After the viewer."))]);

    expect(screen.getByText("This content can't be shown")).toBeTruthy();
    expect(screen.getByText("After the viewer.")).toBeTruthy();
    await new Promise((done) => setTimeout(done, 20));
    expect(api.calls()).toHaveLength(0);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(String(log.error.mock.calls[0][0])).toContain("CodeSteps");
  });

  it("shows the code-step box with one error and sends no request where the lesson's IDs are not known", async () => {
    const log = spyOnConsole();
    const api = serve();
    renderTree([steps({ step: "1" }), paragraph(text("After the viewer."))]);

    expect(screen.getByText("This code step can't be shown")).toBeTruthy();
    expect(screen.getByText("After the viewer.")).toBeTruthy();
    await new Promise((done) => setTimeout(done, 20));
    expect(api.calls()).toHaveLength(0);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(String(log.error.mock.calls[0][0])).toContain("CodeSteps");
  });
});

describe("files and tabs", () => {
  it("has one tab for each file in the API's order, labelled with the full path", async () => {
    serve(oneStep(file("src/util.py", "a"), file("lib/util.py", "b"), file("README.md", "c")));
    show([steps({ step: "1" })]);
    await screen.findByRole("tablist");
    expect(tabNames()).toEqual(["src/util.py", "lib/util.py", "README.md"]);
  });

  it("does not show files that were deleted", async () => {
    serve();
    show([steps({ step: "3" })]);
    await screen.findByRole("tablist");
    expect(tabNames()).toEqual(["main.py", "pkg/__init__.py", "pkg/util.py", "settings.txt"]);
  });

  it("shows one tab for a step with one file", async () => {
    serve(oneStep(file("only.py", "x = 1\n")));
    show([steps({ step: "1" })]);
    await screen.findByRole("tablist");
    expect(tabs()).toHaveLength(1);
  });

  it("selects the first tab when there is no file prop", async () => {
    serve();
    show([steps({ step: "2" })]);
    await screen.findByRole("tablist");
    expect(selectedTab()?.textContent).toBe("helper.py");
  });

  it("selects the file named in the file prop", async () => {
    const log = spyOnConsole();
    serve();
    show([steps({ step: "2", file: "pkg/util.py" })]);
    await screen.findByRole("tablist");
    expect(selectedTab()?.textContent).toBe("pkg/util.py");
    expect(codeText()).toBe("def shout(text):\n    return text.upper()\n");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([["a file that is not in the step", "nope.py"], ["a file that was deleted in the step", "helper.py"]])(
    "selects the first tab and warns once for %s",
    async (_name, name) => {
      const log = spyOnConsole();
      serve();
      show([steps({ step: "3", file: name })], { strict: true });
      await screen.findByRole("tablist");
      expect(selectedTab()?.textContent).toBe("main.py");
      await waitFor(() => expect(log.warn).toHaveBeenCalledTimes(1));
      await new Promise((done) => setTimeout(done, 20));
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.error).not.toHaveBeenCalled();
    },
  );

  it("follows the tabs pattern: roles, names, aria-selected, aria-controls and a roving tabindex", async () => {
    serve();
    const { container } = show([steps({ step: "2" })]);
    await screen.findByRole("tablist");

    expect(screen.getByRole("tablist").getAttribute("aria-label")).toBe("Files in step 2");
    expect(tabs().map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false", "false"]);
    expect(tabs().map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1", "-1", "-1"]);
    for (const t of tabs()) expect(t.getAttribute("type")).toBe("button");
    const panels = container.querySelectorAll("[role=tabpanel]");
    expect(panels).toHaveLength(1);
    expect(tabs()[0].getAttribute("aria-controls")).toBe(panels[0].id);
    expect(panels[0].getAttribute("aria-labelledby")).toBe(tabs()[0].id);
  });

  it("shows only the selected file's code, in a focusable area named by the file path", async () => {
    serve();
    const { user, container } = show([steps({ step: "2" })]);
    await screen.findByRole("tablist");

    const area = screen.getByRole("region", { name: "helper.py" });
    expect(area.getAttribute("tabindex")).toBe("0");
    expect(codeText()).toBe("def helper():\n    return 1\n");

    await user.click(screen.getByRole("tab", { name: "main.py" }));
    expect(screen.getByRole("region", { name: "main.py" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "helper.py" })).toBeNull();
    expect(container.querySelectorAll(".code-area")).toHaveLength(1);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(screen.getByRole("tab", { name: "main.py" }).id);
  });

  it("puts the selected tab, then the Copy button, then the code area in the Tab key order", async () => {
    serve();
    const { user } = show([steps({ step: "1" })]);
    await screen.findByRole("tablist");

    await user.tab();
    expect(document.activeElement).toBe(selectedTab());
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Copy/ }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "helper.py" }));
  });

  it("selects a tab on click", async () => {
    serve();
    const { user } = show([steps({ step: "2" })]);
    await screen.findByRole("tablist");

    await user.click(screen.getByRole("tab", { name: "pkg/util.py" }));

    expect(selectedTab()?.textContent).toBe("pkg/util.py");
    expect(tabs().map((t) => t.getAttribute("tabindex"))).toEqual(["-1", "-1", "-1", "0", "-1"]);
  });

  describe("the keyboard", () => {
    async function focusFirst() {
      serve();
      const view = show([steps({ step: "2" })]);
      await screen.findByRole("tablist");
      tabs()[0].focus();
      return view;
    }

    it("moves to the next tab with Right Arrow and wraps from the last to the first", async () => {
      const { user } = await focusFirst();
      await user.keyboard("{ArrowRight}");
      expect(selectedTab()?.textContent).toBe("main.py");
      expect(document.activeElement).toBe(selectedTab());
      await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}");
      expect(selectedTab()?.textContent).toBe("helper.py");
    });

    it("moves to the previous tab with Left Arrow and wraps from the first to the last", async () => {
      const { user } = await focusFirst();
      await user.keyboard("{ArrowLeft}");
      expect(selectedTab()?.textContent).toBe("settings.txt");
      await user.keyboard("{ArrowLeft}");
      expect(selectedTab()?.textContent).toBe("pkg/util.py");
    });

    it("goes to the first tab with Home and the last with End, and shows that file at once", async () => {
      const { user } = await focusFirst();
      await user.keyboard("{End}");
      expect(selectedTab()?.textContent).toBe("settings.txt");
      expect(document.activeElement).toBe(selectedTab());
      expect(screen.getByRole("region", { name: "settings.txt" })).toBeTruthy();
      await user.keyboard("{Home}");
      expect(selectedTab()?.textContent).toBe("helper.py");
    });

    it.each(["{ArrowUp}", "{ArrowDown}", "a", "{Enter}", "{PageDown}"])("does nothing for %s", async (key) => {
      const { user } = await focusFirst();
      await user.keyboard(key);
      expect(selectedTab()?.textContent).toBe("helper.py");
    });

    it.each(["Control", "Alt", "Meta", "Shift"])("does nothing for an arrow key with %s held", async (modifier) => {
      const { user } = await focusFirst();
      await user.keyboard(`{${modifier}>}{ArrowRight}{End}{/${modifier}}`);
      expect(selectedTab()?.textContent).toBe("helper.py");
    });
  });

  it.each(["__proto__", "constructor", "toString", "hasOwnProperty", "<script>alert(1)</script>", "&amp;", "a&lt;b"])(
    "gives a file called %j a tab and a panel and shows it as text",
    async (path) => {
      serve(oneStep(file("first.txt", "one"), file(path, "<b>not bold</b>\n")));
      const { user, container } = show([steps({ step: "1" })]);
      await screen.findByRole("tablist");

      await user.click(screen.getByRole("tab", { name: path }));

      expect(selectedTab()?.textContent).toBe(path);
      expect(screen.getByRole("region", { name: path })).toBeTruthy();
      expect(codeText()).toBe("<b>not bold</b>\n");
      expect(container.querySelector("script, b")).toBeNull();
    },
  );

  it("can start on a file called __proto__ from the file prop", async () => {
    serve(oneStep(file("first.txt", "one"), file("__proto__", "two")));
    show([steps({ step: "1", file: "__proto__" })]);
    await screen.findByRole("tablist");
    expect(selectedTab()?.textContent).toBe("__proto__");
  });
});

describe("highlighting", () => {
  it("shows plain text first and then the colors, on the same line elements", async () => {
    serve();
    const colors = deferred<Awaited<ReturnType<typeof highlight>>>();
    vi.mocked(highlight).mockReturnValue(colors.promise);
    const { container } = show([steps({ step: "1" })]);
    await screen.findByRole("tablist");

    const before = Array.from(container.querySelectorAll(".code-line"));
    expect(before).toHaveLength(2);
    expect(container.querySelectorAll(".code-token-keyword")).toHaveLength(0);
    expect(codeText()).toBe("def helper():\n    return 1\n");

    await act(async () => {
      colors.resolve([[{ text: "def helper():", className: "code-token-keyword" }], [{ text: "    return 1", className: "code-token-keyword" }]]);
    });

    await waitFor(() => expect(container.querySelectorAll(".code-token-keyword")).toHaveLength(2));
    const after = Array.from(container.querySelectorAll(".code-line"));
    expect(after).toHaveLength(2);
    after.forEach((line, index) => expect(line).toBe(before[index]));
    expect(codeText()).toBe("def helper():\n    return 1\n");
  });

  it("asks the highlighter for the file's content and language only for a language it knows", async () => {
    serve();
    const { user } = show([steps({ step: "1" })]);
    await screen.findByRole("tablist");
    await waitFor(() => expect(highlight).toHaveBeenCalledWith("def helper():\n    return 1\n", "python"));
    const calls = vi.mocked(highlight).mock.calls.length;

    await user.click(screen.getByRole("tab", { name: "settings.txt" }));

    expect(screen.getByRole("region", { name: "settings.txt" })).toBeTruthy();
    expect(vi.mocked(highlight).mock.calls.length).toBe(calls);
    expect(document.querySelectorAll(".code-token-keyword")).toHaveLength(0);
    expect(codeText()).toBe("greeting = héllo\n");
  });

  it("asks for no highlighting of a file over 100,000 characters, and does for one of exactly 100,000", async () => {
    // Ten long lines, so the page has little to draw.
    const exact = `${"x".repeat(MAX_HIGHLIGHT_CHARS / 10 - 1)}\n`.repeat(10);
    expect(exact).toHaveLength(MAX_HIGHLIGHT_CHARS);
    serve(oneStep(file("exact.py", exact), file("over.py", exact + "z")));
    const { user } = show([steps({ step: "1" })]);
    await screen.findByRole("tablist");
    await waitFor(() => expect(highlight).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("tab", { name: "over.py" }));
    await screen.findByRole("region", { name: "over.py" });

    expect(highlight).toHaveBeenCalledTimes(1);
    expect(codeText()).toBe(exact + "z");
  });

  it("keeps the file as plain text, with Copy working and no error, when the highlighter gives nothing", async () => {
    const log = spyOnConsole();
    vi.mocked(highlight).mockResolvedValue(null);
    serve();
    const { user } = show([steps({ step: "1" })]);
    await screen.findByRole("tablist");
    await waitFor(() => expect(highlight).toHaveBeenCalled());

    expect(screen.queryByRole("alert")).toBeNull();
    expect(codeText()).toBe("def helper():\n    return 1\n");
    await user.click(screen.getByRole("button", { name: /^Copy/ }));
    expect(await navigator.clipboard.readText()).toBe("def helper():\n    return 1\n");
    expect(log.error).not.toHaveBeenCalled();
  });

  it("does not let the colors of one file land on another when the learner switches tabs", async () => {
    const slow = deferred<Awaited<ReturnType<typeof highlight>>>();
    vi.mocked(highlight).mockReturnValueOnce(slow.promise);
    serve();
    const { user, container } = show([steps({ step: "1" })]);
    await screen.findByRole("tablist");

    await user.click(screen.getByRole("tab", { name: "settings.txt" }));
    await act(async () => {
      slow.resolve([[{ text: "def helper():", className: "code-token-keyword" }], [{ text: "    return 1", className: "code-token-keyword" }]]);
    });

    expect(codeText()).toBe("greeting = héllo\n");
    expect(container.querySelectorAll(".code-token-keyword")).toHaveLength(0);
  });
});

describe("line numbers", () => {
  const numbers = () => Array.from(document.querySelectorAll(".code-line-number")).map((n) => n.textContent);

  it.each([
    ["a file of three lines with a final newline", "a\nb\nc\n", ["1", "2", "3"]],
    ["a file of three lines without a final newline", "a\nb\nc", ["1", "2", "3"]],
    ["a file with no newline", "one line", ["1"]],
    ["a file of one empty line", "\n", ["1"]],
    ["a file with an empty line in it", "a\n\nb\n", ["1", "2", "3"]],
  ])("shows 1 to N for %s", async (_name, content, expected) => {
    serve(oneStep(file("f.txt", content)));
    show([steps({ step: "1" })]);
    await screen.findByRole("tablist");
    expect(numbers()).toEqual(expected);
    expect(codeText()).toBe(content);
  });

  it("shows This file is empty, no code area, and a Copy button that copies the empty string, for an empty file", async () => {
    serve(oneStep(file("empty.py", "")));
    const { user } = show([steps({ step: "1" })]);
    await screen.findByRole("tablist");

    expect(screen.getByText("This file is empty")).toBeTruthy();
    expect(document.querySelector(".code-area")).toBeNull();
    expect(numbers()).toEqual([]);
    const write = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(screen.getByRole("button", { name: /^Copy/ }));
    expect(write).toHaveBeenCalledExactlyOnceWith("");
    expect(screen.getByRole("button", { name: /^Copied/ })).toBeTruthy();
    expect(highlight).not.toHaveBeenCalled();
  });

  it("keeps a lone carriage return inside its line and does not start a new numbered line", async () => {
    serve(oneStep(file("cr.txt", "a\rb\nc\n")));
    show([steps({ step: "1" })]);
    await screen.findByRole("tablist");
    expect(numbers()).toEqual(["1", "2"]);
    expect(codeText()).toBe("a\rb\nc\n");
  });

  it("keeps the numbers out of the text of the code and hides them from screen readers", async () => {
    serve();
    const { container } = show([steps({ step: "2" })]);
    await screen.findByRole("tablist");

    for (const number of container.querySelectorAll(".code-line-number")) {
      expect(number.getAttribute("aria-hidden")).toBe("true");
      expect(number.closest(".code-line-text")).toBeNull();
    }
    expect(container.querySelectorAll(".code-line-text .code-line-number")).toHaveLength(0);
    expect(codeText()).toBe("def helper():\n    return 1\n");
  });

  it("makes one element for each line, in order, each holding its number and its own text", async () => {
    serve();
    const { container } = show([steps({ step: "2", file: "main.py" })]);
    await screen.findByRole("tablist");

    const lines = Array.from(container.querySelectorAll(".code-line"));
    expect(lines).toHaveLength(5);
    expect(lines.map((line) => line.querySelector(".code-line-text")?.textContent)).toEqual([
      "from helper import helper\n",
      "from pkg.util import shout\n",
      "\n",
      'print(shout("hello"))\n',
      "print(helper())\n",
    ]);
  });

  it("keeps the code area for a file when another file is selected and selected again", async () => {
    serve();
    const { user } = show([steps({ step: "1" })]);
    await screen.findByRole("tablist");
    await user.click(screen.getByRole("tab", { name: "main.py" }));
    expect(screen.getByRole("region", { name: "main.py" })).toBeTruthy();
  });
});

describe("copying", () => {
  const copyButton = () => screen.getByRole("button", { name: /^Cop/ });

  it("copies the exact content of the file, with its indentation and final newline", async () => {
    serve();
    const { user } = show([steps({ step: "2", file: "pkg/util.py" })]);
    await screen.findByRole("tablist");

    await user.click(copyButton());

    expect(await navigator.clipboard.readText()).toBe("def shout(text):\n    return text.upper()\n");
  });

  it("copies the content from the API data and not from the page", async () => {
    // A highlighter result that differs from the content must not reach the clipboard.
    vi.mocked(highlight).mockResolvedValue([[{ text: "WRONG", className: null }], [{ text: "WRONG", className: null }]]);
    serve();
    const { user } = show([steps({ step: "1" })]);
    await screen.findByRole("tablist");
    await waitFor(() => expect(highlight).toHaveBeenCalled());

    await user.click(copyButton());

    expect(await navigator.clipboard.readText()).toBe("def helper():\n    return 1\n");
  });

  it("copies a file of tabs, non-ASCII text and no final newline exactly", async () => {
    const content = "\tcafé\t☕\n\n  x";
    serve(oneStep(file("odd.txt", content)));
    const { user } = show([steps({ step: "1" })]);
    await screen.findByRole("tablist");
    await user.click(copyButton());
    expect(await navigator.clipboard.readText()).toBe(content);
  });

  it("has a visible text that the accessible name starts with, and a name that tells the file apart", async () => {
    serve();
    const { user } = show([steps({ step: "2", file: "main.py" }), steps({ step: "1", file: "helper.py" })]);
    await waitFor(() => expect(screen.getAllByRole("tablist")).toHaveLength(2));

    const buttons = screen.getAllByRole("button", { name: /^Copy/ });
    expect(buttons.map((button) => button.getAttribute("class"))).toEqual(["button button-secondary", "button button-secondary"]);
    expect(buttons.map((button) => button.textContent?.trim().startsWith("Copy"))).toEqual([true, true]);
    expect(screen.getByRole("button", { name: "Copy main.py" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy helper.py" })).toBeTruthy();
    // Only the word is seen; the file name is for screen readers.
    expect(screen.getByRole("button", { name: "Copy main.py" }).querySelector(".visually-hidden")?.textContent).toBe("main.py");

    await user.click(screen.getByRole("tab", { name: "pkg/util.py" }));
    expect(screen.getByRole("button", { name: "Copy pkg/util.py" })).toBeTruthy();
  });

  it("is a button of the secondary kind in a live region that was there before the first press", async () => {
    serve();
    const { user } = show([steps({ step: "1" })]);
    await screen.findByRole("tablist");
    const region = copyButton().closest("[aria-live]");
    expect(region?.getAttribute("aria-live")).toBe("polite");

    await user.click(copyButton());

    expect(screen.getByRole("button", { name: /^Copied/ }).closest("[aria-live]")).toBe(region);
  });

  describe("with a clock", () => {
    /** Loads the viewer with real timers, then fakes the clock for the 2 seconds. */
    async function ready(nodes: unknown[] = [steps({ step: "2", file: "pkg/util.py" })]) {
      serve();
      const view = show(nodes);
      await screen.findByRole("tablist");
      vi.useFakeTimers();
      return view;
    }
    const press = async (target: HTMLElement = copyButton()) => {
      await act(async () => {
        fireEvent.click(target);
      });
    };
    const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));
    const label = () => copyButton().textContent?.trim();

    it("reads Copied for 2 seconds, then Copy", async () => {
      await ready();
      expect(label()).toBe("Copy pkg/util.py");

      await press();
      expect(label()).toBe("Copied pkg/util.py");
      await wait(1999);
      expect(label()).toBe("Copied pkg/util.py");
      await wait(1);
      expect(label()).toBe("Copy pkg/util.py");
    });

    it("starts the 2 seconds again when it is pressed again at 1.5 seconds", async () => {
      await ready();
      await press();
      await wait(1500);
      await press();
      await wait(1999);
      expect(label()).toBe("Copied pkg/util.py");
      await wait(1);
      expect(label()).toBe("Copy pkg/util.py");
    });

    it("causes no warning when it is unmounted during the 2 seconds", async () => {
      const log = spyOnConsole();
      const view = await ready();
      await press();

      view.unmount();
      await act(() => vi.advanceTimersByTime(5000));

      expect(log.error).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("goes back to Copy for the new file when another tab is chosen, and the old timer changes nothing", async () => {
      await ready([steps({ step: "2" })]);
      await press();
      await wait(1000);
      expect(label()).toBe("Copied helper.py");

      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: "main.py" }));
      });
      expect(label()).toBe("Copy main.py");

      await press();
      expect(label()).toBe("Copied main.py");
      // The first press would have ended at 2000 ms; the second press has until 3000 ms.
      await wait(1000);
      expect(label()).toBe("Copied main.py");
      await wait(1000);
      expect(label()).toBe("Copy main.py");
    });

    it("does not show Copied for the new file when the clipboard answers after the tab was changed", async () => {
      const slow = deferred<void>();
      await ready([steps({ step: "2" })]);
      vi.spyOn(navigator.clipboard, "writeText").mockReturnValueOnce(slow.promise);

      await press();
      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: "main.py" }));
      });
      await act(async () => {
        slow.resolve();
      });

      expect(label()).toBe("Copy main.py");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps the failure message until the next press, however long it waits", async () => {
      const log = spyOnConsole();
      await ready();
      vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new DOMException("Not allowed", "NotAllowedError"));

      await press();
      expect(label()).toBe("Copy failed – select the code to copy it");
      await wait(60_000);
      expect(label()).toBe("Copy failed – select the code to copy it");
      expect(log.error).not.toHaveBeenCalled();
    });
  });

  it("says Copy failed when navigator.clipboard is missing, and does not log an error", async () => {
    const log = spyOnConsole();
    serve();
    const { user } = show([steps({ step: "1" })]);
    await screen.findByRole("tablist");
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    try {
      await user.click(copyButton());
      expect(screen.getByRole("button", { name: "Copy failed – select the code to copy it" })).toBeTruthy();
      expect(log.error).not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
    }
  });

  it("says Copy failed when writeText is refused, and the code stays selectable", async () => {
    const log = spyOnConsole();
    serve();
    const { user } = show([steps({ step: "1" })]);
    await screen.findByRole("tablist");
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new DOMException("Not allowed", "NotAllowedError"));

    await user.click(copyButton());

    const button = screen.getByRole("button", { name: "Copy failed – select the code to copy it" });
    expect(button.closest("[aria-live]")?.getAttribute("aria-live")).toBe("polite");
    expect(codeText()).toBe("def helper():\n    return 1\n");
    expect(log.error).not.toHaveBeenCalled();
  });

  it("tries again when pressed after a failure, and goes back to Copy when another file is chosen", async () => {
    serve();
    const { user } = show([steps({ step: "1" })]);
    await screen.findByRole("tablist");
    const write = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("no"));

    await user.click(copyButton());
    expect(copyButton().textContent).toBe("Copy failed – select the code to copy it");
    await user.click(copyButton());
    expect(copyButton().textContent?.trim()).toBe("Copied helper.py");
    expect(write).toHaveBeenCalledTimes(2);

    write.mockRejectedValueOnce(new Error("no"));
    await user.click(copyButton());
    expect(copyButton().textContent).toBe("Copy failed – select the code to copy it");
    await user.click(screen.getByRole("tab", { name: "main.py" }));
    expect(copyButton().textContent?.trim()).toBe("Copy main.py");
  });
});

describe("the ZIP link", () => {
  it("is a link to the ZIP's URL that downloads under the API's file name, with a hint that says it is the whole chapter", async () => {
    const api = serve();
    const { container } = show([steps({ step: "2" })]);
    await screen.findByRole("tablist");

    const link = screen.getByRole("link", { name: "Download chapter code (ZIP)" });
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/api/courses/sample-course/chapters/01-first-steps/code.zip");
    expect(link.getAttribute("download")).toBe("01-first-steps.zip");
    expect(link.className).toContain("link-action");
    expect(screen.getByText("This ZIP has the final code of the whole chapter, not only step 2.")).toBeTruthy();
    expect(container.querySelector("button[download]")).toBeNull();
    // The link is only a link: nothing fetched it.
    expect(api.calls(CODE)).toHaveLength(1);
    expect(api.calls()).toHaveLength(1);
  });

  it("names the step of its own viewer in the hint", async () => {
    serve();
    show([steps({ step: "1" }), steps({ step: "3" })]);
    await waitFor(() => expect(screen.getAllByRole("tablist")).toHaveLength(2));
    expect(screen.getByText("This ZIP has the final code of the whole chapter, not only step 1.")).toBeTruthy();
    expect(screen.getByText("This ZIP has the final code of the whole chapter, not only step 3.")).toBeTruthy();
  });

  it.each(["https://other.example/x.zip", "//host/x.zip", "javascript:alert(1)", "relative/x.zip", "", "/\\evil.example/x.zip", "/api/x\n.zip"])(
    "does not use the ZIP URL %j: the link is not shown and the rest works",
    async (url) => {
      const log = spyOnConsole();
      serve(chapter((d) => (d.zip.url = url)));
      show([steps({ step: "1" })]);
      await screen.findByRole("tablist");

      expect(screen.queryByRole("link")).toBeNull();
      expect(document.querySelector("[download]")).toBeNull();
      expect(screen.getByRole("region", { name: "helper.py" })).toBeTruthy();
      expect(log.error).not.toHaveBeenCalled();
    },
  );
});
