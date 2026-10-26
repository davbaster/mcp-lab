import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNEXPECTED_RESPONSE_MESSAGE } from "../api/apiError";
import { apiRoutes, deferred } from "../test/apiRoutes";
import { jsonResponse } from "../test/mockApi";
import { component, paragraph, renderTree, spyOnConsole, tab, text } from "../test/renderTree";
import { splitLines } from "./codeLines";
import golden from "./fixtures/chapter-code.response.json";
import { highlight } from "./highlighter";

// Step mode (#22) over the same data as #21's tests. The highlighter is a stand-in, as there.
vi.mock("./highlighter", async (importOriginal) => ({ ...(await importOriginal<typeof import("./highlighter")>()), highlight: vi.fn() }));

const IDS = { courseId: "sample-course", chapterId: "01-first-steps" };
const CODE = "GET /api/courses/sample-course/chapters/01-first-steps/code";

type Chapter = typeof golden;
type FileData = Chapter["steps"][number]["files"][number];
type StepData = Chapter["steps"][number];
const chapter = (change: (data: Chapter) => void = () => {}): Chapter => {
  const data = structuredClone(golden);
  change(data);
  return data;
};
const file = (path: string, status: string, content = "a\nb\nc\n", changed_lines: number[] = []): FileData => ({ path, status, content, changed_lines }) as FileData;
/** A chapter whose steps hold these files, in order. */
const withSteps = (...steps: FileData[][]): Chapter => chapter((data) => (data.steps = steps.map((files, index) => ({ step: index + 1, files }) as StepData)));
/** The golden chapter with the files of one step (1, 2 or 3) replaced. */
const withFiles = (step: number, files: FileData[]): Chapter => chapter((data) => (data.steps[step - 1].files = files));

function serve(body: unknown = golden) {
  return apiRoutes({ [CODE]: () => jsonResponse(body) });
}

const steps = (props: Record<string, unknown>) => component("CodeSteps", props);
const show = (nodes: unknown[], options: Parameters<typeof renderTree>[1] = {}) => renderTree(nodes, { lesson: IDS, ...options });
const tabs = () => screen.getAllByRole("tab");
const tabNames = () => tabs().map((t) => t.textContent);
const selectedTab = () => tabs().find((t) => t.getAttribute("aria-selected") === "true");
const selectedPath = () => selectedTab()?.firstChild?.textContent;
const codeText = () =>
  Array.from(document.querySelectorAll(".code-line-text"))
    .map((line) => line.textContent)
    .join("");
const next = () => screen.getByRole("button", { name: "Next step" });
const previous = () => screen.getByRole("button", { name: "Previous step" });
const lineElements = (root: ParentNode = document) => Array.from(root.querySelectorAll<HTMLElement>(".code-line"));
/** The numbers of the lines that carry the "changed" text. */
const markedNumbers = () =>
  lineElements()
    .map((line, index) => (within(line).queryByText("changed") ? index + 1 : 0))
    .filter((number) => number > 0);
const changesLine = () => document.querySelector(".code-step-changes")?.textContent;

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

/** Shows the golden chapter from `step` and waits for the viewer. */
async function open(step: string, extra: Record<string, unknown> = {}) {
  const api = serve();
  const view = show([steps({ step, ...extra })]);
  await screen.findByRole("tablist");
  return { ...view, api };
}

describe("the step buttons", () => {
  it("shows Step N of M and two secondary buttons of at least 44px in one row above the tabs", async () => {
    const { container } = await open("2");

    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
    for (const button of [previous(), next()]) {
      expect(button.getAttribute("type")).toBe("button");
      expect(button.className).toBe("button button-secondary");
    }
    const bar = container.querySelector(".code-step-bar");
    expect(bar?.contains(screen.getByText("Step 2 of 3"))).toBe(true);
    expect(bar?.contains(previous())).toBe(true);
    expect(bar?.contains(next())).toBe(true);
    expect(bar?.compareDocumentPosition(screen.getByRole("tablist")) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("starts on the step named in the prop, with both buttons enabled on a middle step", async () => {
    await open("2");
    expect(screen.getByRole("tablist").getAttribute("aria-label")).toBe("Files in step 2");
    expect(previous().hasAttribute("disabled")).toBe(false);
    expect(next().hasAttribute("disabled")).toBe(false);
  });

  it("disables Previous on step 1 and Next on the last step", async () => {
    const { user } = await open("1");
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    expect(previous().hasAttribute("disabled")).toBe(true);
    expect(next().hasAttribute("disabled")).toBe(false);

    await user.click(next());
    await user.click(next());

    expect(screen.getByText("Step 3 of 3")).toBeTruthy();
    expect(next().hasAttribute("disabled")).toBe(true);
    expect(previous().hasAttribute("disabled")).toBe(false);
  });

  it("shows Step 1 of 1 with both buttons disabled for a chapter of one step", async () => {
    serve(withSteps([file("only.py", "added")]));
    show([steps({ step: "1" })]);
    await screen.findByRole("tablist");
    expect(screen.getByText("Step 1 of 1")).toBeTruthy();
    expect(previous().hasAttribute("disabled")).toBe(true);
    expect(next().hasAttribute("disabled")).toBe(true);
  });

  it("goes forward and back with the mouse: the count, the tab list label and every file change with the step", async () => {
    const { user } = await open("2");
    expect(tabNames()).toEqual(["helper.py", "main.py Changed", "pkg/__init__.py New", "pkg/util.py New", "settings.txt"]);

    await user.click(next());

    expect(screen.getByText("Step 3 of 3")).toBeTruthy();
    expect(screen.getByRole("tablist").getAttribute("aria-label")).toBe("Files in step 3");
    expect(tabNames()).toEqual(["helper.py Deleted", "main.py Changed", "pkg/__init__.py", "pkg/util.py Changed", "settings.txt"]);
    expect(codeText()).toBe('from pkg.util import shout\n\nprint(shout("hello"))\nprint(shout("done"))\n');

    await user.click(previous());
    await user.click(previous());

    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    expect(screen.getByRole("tablist").getAttribute("aria-label")).toBe("Files in step 1");
    expect(tabNames()).toEqual(["helper.py", "main.py", "settings.txt"]);
    expect(codeText()).toBe('from helper import helper\n\nprint("hello")\nprint(helper())\n');
  });

  it("goes forward and back with the keyboard, Enter and Space", async () => {
    const { user } = await open("1");
    next().focus();

    await user.keyboard("{Enter}");
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
    await user.keyboard(" ");
    expect(screen.getByText("Step 3 of 3")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(previous()));
    await user.keyboard("{Enter}");
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
  });

  it("sends no request when the step changes", async () => {
    const { user, api } = await open("1");
    for (let click = 0; click < 2; click += 1) await user.click(next());
    for (let click = 0; click < 2; click += 1) await user.click(previous());
    expect(api.calls(CODE)).toHaveLength(1);
    expect(api.calls()).toHaveLength(1);
  });

  it("shows the step ten clicks on, capped at the last, with no request", async () => {
    const { api } = await open("1");
    for (let click = 0; click < 10; click += 1) fireEvent.click(next());
    expect(screen.getByText("Step 3 of 3")).toBeTruthy();
    for (let click = 0; click < 10; click += 1) fireEvent.click(previous());
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    expect(api.calls()).toHaveLength(1);
  });

  it("writes no step, file or scroll state anywhere, and starts again on the prop after the lesson is left", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const first = await open("1");
    await first.user.click(next());
    await first.user.click(screen.getByRole("tab", { name: /^pkg\/util\.py/ }));
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
    first.unmount();

    show([steps({ step: "1" })]);
    await screen.findByRole("tablist");

    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("shows no navigation in the box for a starting step that is not in the data", async () => {
    spyOnConsole();
    serve();
    show([steps({ step: "9" })]);
    expect(await screen.findByText("This code step can't be shown")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next step" })).toBeNull();
    expect(screen.queryByText(/^Step \d/)).toBeNull();
  });
});

describe("focus", () => {
  it("keeps the focus on the pressed button when it stays enabled, and moves none on a step change", async () => {
    const { user } = await open("1");
    await user.click(next());
    expect(document.activeElement).toBe(next());
    expect(screen.getByRole("status").hasAttribute("tabindex")).toBe(false);
  });

  it("moves the focus to Previous when Next is pressed twice from step 1 and the keyboard ends on step 3", async () => {
    const { user } = await open("1");
    next().focus();

    await user.keyboard("{Enter}");
    await user.keyboard(" ");

    expect(screen.getByText("Step 3 of 3")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(previous()));
  });

  it("moves the focus to Next when Previous is pressed down to step 1", async () => {
    const { user } = await open("2");
    previous().focus();

    await user.keyboard("{Enter}");

    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(next()));
  });

  it("moves the focus to Previous when the first press of Next ends a chapter of two steps (Previous was disabled)", async () => {
    serve(withSteps([file("a.py", "added")], [file("a.py", "modified", "a\n", [1])]));
    const { user } = show([steps({ step: "1" })]);
    await screen.findByRole("tablist");

    await user.click(next());

    expect(screen.getByText("Step 2 of 2")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(previous()));
  });
});

describe("the status", () => {
  it("is one element that is on the page before the first click, with the count and the changes in two children, and it is not focusable", async () => {
    const { user } = await open("2");
    const status = screen.getByRole("status");

    expect(status.getAttribute("tabindex")).toBeNull();
    expect(Array.from(status.children).map((child) => child.textContent)).toEqual(["Step 2 of 3", "1 file changed, 2 added"]);
    expect(status.contains(screen.getByText("Step 2 of 3"))).toBe(true);

    await user.click(next());

    // The same element is updated, so a screen reader announces the change.
    expect(screen.getByRole("status")).toBe(status);
    expect(Array.from(status.children).map((child) => child.textContent)).toEqual(["Step 3 of 3", "2 files changed, 1 deleted"]);
  });

  it("says the first step's note on step 1, also when the learner comes back to it", async () => {
    const { user } = await open("2");
    await user.click(previous());
    expect(screen.getByRole("status").textContent).toBe("Step 1 of 3First step: every file is new.");
    expect(changesLine()).toBe("First step: every file is new.");
  });
});

describe("keeping the selected file", () => {
  it("keeps the file selected and the very same code area, with its scroll position, when the file is in the next step", async () => {
    const { user } = await open("2", { file: "pkg/util.py" });
    const area = screen.getByRole("region", { name: "pkg/util.py" });
    area.scrollTop = 7;
    area.scrollLeft = 5;

    await user.click(next());

    expect(selectedPath()).toBe("pkg/util.py");
    const after = screen.getByRole("region", { name: "pkg/util.py" });
    expect(after).toBe(area);
    expect(after.scrollTop).toBe(7);
    expect(after.scrollLeft).toBe(5);
    expect(codeText()).toBe('def shout(text):\n    return text.upper() + "!"\n');
  });

  it("keeps an unchanged file selected, too", async () => {
    const { user } = await open("2", { file: "settings.txt" });
    const area = screen.getByRole("region", { name: "settings.txt" });
    await user.click(next());
    expect(screen.getByRole("region", { name: "settings.txt" })).toBe(area);
  });

  it("selects the first added or modified file, at the top of a new code area, when the file was deleted in the next step", async () => {
    const { user } = await open("2", { file: "helper.py" });
    const area = screen.getByRole("region", { name: "helper.py" });
    area.scrollTop = 9;

    await user.click(next());

    expect(selectedPath()).toBe("main.py");
    expect(screen.queryByRole("region", { name: "helper.py" })).toBeNull();
    const after = screen.getByRole("region", { name: "main.py" });
    expect(after).not.toBe(area);
    expect(after.scrollTop).toBe(0);
  });

  it("selects the first added or modified file when the file is not in the next step at all", async () => {
    serve(
      withSteps(
        [file("one.py", "added"), file("gone.py", "added")],
        [file("one.py", "unchanged"), file("two.py", "added"), file("three.py", "modified", "x\n", [1])],
        [file("one.py", "unchanged"), file("three.py", "unchanged")],
      ),
    );
    const { user } = show([steps({ step: "1", file: "gone.py" })]);
    await screen.findByRole("tablist");
    expect(selectedPath()).toBe("gone.py");

    await user.click(next());
    expect(selectedPath()).toBe("two.py");
  });

  it("selects the first file that is not deleted when no file is added or modified", async () => {
    serve(withSteps([file("a.py", "added"), file("b.py", "added")], [file("a.py", "deleted", ""), file("b.py", "unchanged"), file("c.py", "unchanged")]));
    const { user } = show([steps({ step: "1", file: "a.py" })]);
    await screen.findByRole("tablist");

    await user.click(next());

    expect(selectedPath()).toBe("b.py");
  });

  it("selects the first file when every file is deleted", async () => {
    serve(withSteps([file("a.py", "added"), file("b.py", "added")], [file("a.py", "deleted", ""), file("b.py", "deleted", "")]));
    const { user } = show([steps({ step: "1" })]);
    await screen.findByRole("tablist");

    await user.click(next());

    expect(selectedPath()).toBe("a.py");
    expect(screen.getByText("This file was removed in this step")).toBeTruthy();
  });

  it("shows a file that the learner chose on step 3 as the same deleted tab selected on step 2 after Previous", async () => {
    const { user } = await open("3");
    await user.click(screen.getByRole("tab", { name: "helper.py Deleted" }));
    expect(screen.getByText("This file was removed in this step")).toBeTruthy();

    await user.click(previous());

    expect(selectedPath()).toBe("helper.py");
    expect(codeText()).toBe("def helper():\n    return 1\n");
    expect(screen.queryByText("This file was removed in this step")).toBeNull();
  });

  it("leaves a selected deleted file for the first changed file when the next step no longer has it", async () => {
    serve(
      withSteps(
        [file("a.py", "added"), file("b.py", "added")],
        [file("a.py", "deleted", ""), file("b.py", "modified", "x\n", [1])],
        [file("b.py", "unchanged"), file("c.py", "added", "y\n", [1])],
      ),
    );
    const { user } = show([steps({ step: "2" })]);
    await screen.findByRole("tablist");
    await user.click(screen.getByRole("tab", { name: "a.py Deleted" }));

    await user.click(next());

    expect(tabNames()).toEqual(["b.py", "c.py New"]);
    expect(selectedPath()).toBe("c.py");
  });

  it.each(["__proto__", "constructor", "toString"])("handles a file called %s across steps", async (path) => {
    serve(withSteps([file(path, "added", "one\n")], [file(path, "modified", "two\n", [1]), file("other.py", "added")]));
    const { user } = show([steps({ step: "1" })]);
    await screen.findByRole("tablist");

    await user.click(next());

    expect(selectedPath()).toBe(path);
    expect(codeText()).toBe("two\n");
    expect(markedNumbers()).toEqual([1]);
  });
});

describe("the marked lines", () => {
  it("marks lines 2 and 4 of main.py on step 2, and line 4 only on step 3", async () => {
    const { user } = await open("2");
    expect(selectedPath()).toBe("main.py");
    expect(markedNumbers()).toEqual([2, 4]);

    await user.click(next());

    expect(selectedPath()).toBe("main.py");
    expect(markedNumbers()).toEqual([4]);
    expect(document.querySelectorAll(".code-line-changed")).toHaveLength(1);
  });

  it("marks a line as a whole: the changed class on the line, the text 'changed' in its gutter, and none on the other lines", async () => {
    await open("2");
    const lines = lineElements();
    expect(lines.map((line) => line.classList.contains("code-line-changed"))).toEqual([false, true, false, true, false]);
    for (const line of lines.filter((l) => l.classList.contains("code-line-changed"))) {
      expect(within(line).getAllByText("changed")).toHaveLength(1);
    }
    for (const line of lines.filter((l) => !l.classList.contains("code-line-changed"))) expect(line.textContent).not.toContain("changed");
  });

  it("keeps 'changed' and the bar out of the file's text: outside the code element, readable, and not selectable by class", async () => {
    await open("2");
    const flag = within(lineElements()[1]).getByText("changed");

    expect(flag.closest(".code-line-text")).toBeNull();
    expect(flag.closest("[aria-hidden=true]")).toBeNull();
    expect(flag.classList.contains("visually-hidden")).toBe(true);
    expect(flag.classList.contains("code-line-flag")).toBe(true);
    expect(document.querySelectorAll(".code-line-text .code-line-flag")).toHaveLength(0);
    expect(codeText()).toBe('from helper import helper\nfrom pkg.util import shout\n\nprint(shout("hello"))\nprint(helper())\n');
    // The line number is still hidden from screen readers.
    expect(lineElements()[1].querySelector(".code-line-number")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("copies the exact content of a marked file, with no 'changed' in it", async () => {
    const { user } = await open("2");
    await user.click(screen.getByRole("button", { name: /^Copy/ }));
    const copied = await navigator.clipboard.readText();
    expect(copied).toBe('from helper import helper\nfrom pkg.util import shout\n\nprint(shout("hello"))\nprint(helper())\n');
    expect(copied).not.toContain("changed");
  });

  it("marks the lines on the first render of the step, before the colors arrive, and keeps them on the same elements after", async () => {
    serve();
    const colors = deferred<Awaited<ReturnType<typeof highlight>>>();
    vi.mocked(highlight).mockReturnValue(colors.promise);
    const { container } = show([steps({ step: "2" })]);
    await screen.findByRole("tablist");

    const before = lineElements();
    expect(markedNumbers()).toEqual([2, 4]);
    expect(container.querySelectorAll(".code-token-keyword")).toHaveLength(0);

    await act(async () => {
      colors.resolve(splitLines('from helper import helper\nfrom pkg.util import shout\n\nprint(shout("hello"))\nprint(helper())\n').map((line) => [{ text: line.text, className: "code-token-keyword" }]));
    });

    await waitFor(() => expect(container.querySelectorAll(".code-token-keyword")).toHaveLength(5));
    const after = lineElements();
    after.forEach((line, index) => expect(line).toBe(before[index]));
    expect(markedNumbers()).toEqual([2, 4]);
  });

  it("marks no line on step 1, although the data lists every line, and shows the note instead of the changes line", async () => {
    const { user } = await open("1", { file: "main.py" });
    expect(golden.steps[0].files[1].changed_lines).toEqual([1, 2, 3, 4]);

    expect(markedNumbers()).toEqual([]);
    expect(document.querySelectorAll(".code-line-changed")).toHaveLength(0);
    expect(screen.getByText("First step: every file is new.")).toBeTruthy();

    await user.click(next());
    expect(markedNumbers()).toEqual([2, 4]);
    await user.click(previous());

    expect(markedNumbers()).toEqual([]);
    expect(screen.getByText("First step: every file is new.")).toBeTruthy();
  });

  it("marks every line of a file that is new on a later step", async () => {
    const { user } = await open("1");
    await user.click(next());
    await user.click(screen.getByRole("tab", { name: "pkg/util.py New" }));
    expect(markedNumbers()).toEqual([1, 2]);
  });

  it("ignores a line number that is too large, repeated, out of order, zero or negative, with no crash and nothing logged", async () => {
    const log = spyOnConsole();
    serve(withSteps([file("f.py", "added")], [file("f.py", "modified", "a\nb\nc\nd\n", [2, 2, 99, 3, 1, 0, -4, 4])]));
    show([steps({ step: "2" })]);
    await screen.findByRole("tablist");

    expect(markedNumbers()).toEqual([2, 3, 4]);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["unchanged", "unchanged"],
    ["deleted", "deleted"],
  ])("marks nothing in a file that is %s, even if its changed lines are not empty", async (_name, status) => {
    const log = spyOnConsole();
    serve(withSteps([file("f.py", "added"), file("g.py", "added")], [file("f.py", status, status === "deleted" ? "" : "a\nb\n", [1, 2]), file("g.py", "modified", "x\n", [1])]));
    const { user } = show([steps({ step: "2", file: "f.py" })]);
    await screen.findByRole("tablist");
    if (status === "deleted") await user.click(screen.getByRole("tab", { name: /^f\.py/ }));

    expect(document.querySelectorAll(".code-line-changed")).toHaveLength(0);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("shows a note, and no mark, for a modified file whose change only removed lines", async () => {
    serve(withSteps([file("f.py", "added", "a\nb\nc\n")], [file("f.py", "modified", "a\nc\n", [])]));
    const { user } = show([steps({ step: "2" })]);
    await screen.findByRole("tablist");

    expect(screen.getByText("Lines were removed from this file in this step.")).toBeTruthy();
    expect(markedNumbers()).toEqual([]);
    expect(codeText()).toBe("a\nc\n");
    // The note is in the panel, above the code.
    const panel = screen.getByRole("tabpanel");
    expect(panel.contains(screen.getByText("Lines were removed from this file in this step."))).toBe(true);

    await user.click(previous());
    expect(screen.queryByText("Lines were removed from this file in this step.")).toBeNull();
  });

  it("shows no removed-lines note for a modified file that has marked lines", async () => {
    await open("2");
    expect(screen.queryByText("Lines were removed from this file in this step.")).toBeNull();
  });
});

describe("the changes line", () => {
  const f = (status: string) => file(`${status}-${Math.random().toString(36).slice(2, 8)}.py`, status, "x\n", [1]);
  const many = (status: string, count: number) => Array.from({ length: count }, () => f(status));

  it.each([
    ["modified, added and deleted", { modified: 2, added: 1, deleted: 1 }, "2 files changed, 1 added, 1 deleted"],
    ["one modified file", { modified: 1 }, "1 file changed"],
    ["added and deleted without a modified file", { added: 3, deleted: 1 }, "3 files added, 1 deleted"],
    ["one deleted file", { deleted: 1 }, "1 file deleted"],
    ["one of each", { modified: 1, added: 1, deleted: 1 }, "1 file changed, 1 added, 1 deleted"],
    ["several modified files and one added", { modified: 5, added: 1 }, "5 files changed, 1 added"],
    ["one added file", { added: 1 }, "1 file added"],
    ["unchanged files, which are not counted", { modified: 1, unchanged: 4 }, "1 file changed"],
  ])("reads the counts for %s", async (_name, counts, expected) => {
    const later = Object.entries(counts).flatMap(([status, count]) => many(status, count));
    serve(withSteps([file("first.py", "added")], later.length ? later : [file("x.py", "unchanged")]));
    show([steps({ step: "2" })]);
    await screen.findByRole("tablist");
    expect(changesLine()).toBe(expected);
  });

  it("reads 1 file changed, 2 added on step 2 and 2 files changed, 1 deleted on step 3 of the sample", async () => {
    const { user } = await open("2");
    expect(screen.getByText("1 file changed, 2 added")).toBeTruthy();
    await user.click(next());
    expect(screen.getByText("2 files changed, 1 deleted")).toBeTruthy();
  });

  it("says No changes in this step, instead of the changes line, when every file is unchanged, with the tabs and the code still there", async () => {
    serve(withSteps([file("a.py", "added", "one\n"), file("b.py", "added", "two\n")], [file("a.py", "unchanged", "one\n"), file("b.py", "unchanged", "two\n")]));
    show([steps({ step: "2" })]);
    await screen.findByRole("tablist");

    expect(changesLine()).toBe("No changes in this step");
    expect(tabNames()).toEqual(["a.py", "b.py"]);
    expect(codeText()).toBe("one\n");
    expect(markedNumbers()).toEqual([]);
  });
});

describe("the file labels", () => {
  it("shows New, Changed and Deleted next to the path, and none for an unchanged file", async () => {
    const { user } = await open("2");
    expect(screen.getByRole("tab", { name: "pkg/util.py New" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "main.py Changed" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "helper.py" })).toBeTruthy();
    await user.click(next());
    expect(screen.getByRole("tab", { name: "helper.py Deleted" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "settings.txt" })).toBeTruthy();
    expect(Array.from(document.querySelectorAll(".file-label")).map((label) => label.textContent)).toEqual(["Deleted", "Changed", "Changed"]);
  });

  it("shows no label on step 1, and none when the learner comes back to it", async () => {
    const { user } = await open("1");
    expect(document.querySelectorAll(".file-label")).toHaveLength(0);
    await user.click(next());
    expect(document.querySelectorAll(".file-label").length).toBeGreaterThan(0);
    await user.click(previous());
    expect(document.querySelectorAll(".file-label")).toHaveLength(0);
    expect(tabNames()).toEqual(["helper.py", "main.py", "settings.txt"]);
  });

  it("keeps the New label and says This file is empty for an added file with no content, with no marks", async () => {
    await open("2", { file: "pkg/__init__.py" });
    expect(selectedTab()?.textContent).toBe("pkg/__init__.py New");
    expect(screen.getByText("This file is empty")).toBeTruthy();
    expect(document.querySelector(".code-area")).toBeNull();
    expect(markedNumbers()).toEqual([]);
  });
});

describe("a deleted file", () => {
  it("shows a note, no code area and no Copy button, and gets a tab in the keys' order", async () => {
    const { user } = await open("3");
    const tab = screen.getByRole("tab", { name: "helper.py Deleted" });
    expect(tab.getAttribute("tabindex")).toBe("-1");

    await user.click(tab);

    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(tab.getAttribute("tabindex")).toBe("0");
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText("This file was removed in this step")).toBeTruthy();
    expect(panel.querySelector(".code-area")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Cop/ })).toBeNull();
    expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
  });

  it("is reached by Home, End and the arrow keys like any tab", async () => {
    const { user } = await open("3");
    tabs()[1].focus();

    await user.keyboard("{ArrowLeft}");
    expect(selectedTab()?.textContent).toBe("helper.py Deleted");
    expect(document.activeElement).toBe(selectedTab());
    expect(screen.getByText("This file was removed in this step")).toBeTruthy();

    await user.keyboard("{End}");
    expect(selectedPath()).toBe("settings.txt");
    await user.keyboard("{ArrowRight}");
    expect(selectedPath()).toBe("helper.py");
    await user.keyboard("{ArrowRight}");
    expect(selectedPath()).toBe("main.py");
    await user.keyboard("{Home}");
    expect(selectedPath()).toBe("helper.py");
  });

  it("does not offer a Copy button where the next file has none, and offers it again on a file with code", async () => {
    const { user } = await open("3");
    await user.click(screen.getByRole("tab", { name: "helper.py Deleted" }));
    expect(screen.queryByRole("button", { name: /^Cop/ })).toBeNull();
    await user.click(screen.getByRole("tab", { name: /^main\.py/ }));
    expect(screen.getByRole("button", { name: "Copy main.py" })).toBeTruthy();
  });
});

describe("Copied and a step change", () => {
  it("goes back to Copy when the step changes, although the same file stays selected", async () => {
    const { user } = await open("2", { file: "pkg/util.py" });
    await user.click(screen.getByRole("button", { name: /^Copy/ }));
    expect(screen.getByRole("button", { name: "Copied pkg/util.py" })).toBeTruthy();

    await user.click(next());

    expect(screen.getByRole("button", { name: "Copy pkg/util.py" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Copied/ })).toBeNull();
  });

  it("does not show Copied for the new step when the clipboard answers after the step was changed", async () => {
    const slow = deferred<void>();
    await open("2", { file: "pkg/util.py" });
    vi.spyOn(navigator.clipboard, "writeText").mockReturnValueOnce(slow.promise);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Copy/ }));
    });

    await act(async () => {
      fireEvent.click(next());
    });
    await act(async () => {
      slow.resolve();
    });

    expect(screen.getByRole("button", { name: "Copy pkg/util.py" })).toBeTruthy();
  });

  it("copies the content of the step shown after a step change", async () => {
    const { user } = await open("2", { file: "pkg/util.py" });
    await user.click(next());
    await user.click(screen.getByRole("button", { name: /^Copy/ }));
    expect(await navigator.clipboard.readText()).toBe('def shout(text):\n    return text.upper() + "!"\n');
  });
});

describe("the ZIP hint", () => {
  it("follows the step shown and says nothing about steps on the last one", async () => {
    const { user } = await open("1");
    expect(screen.getByText("This ZIP has the final code of the whole chapter (step 3), not only step 1.")).toBeTruthy();
    await user.click(next());
    expect(screen.getByText("This ZIP has the final code of the whole chapter (step 3), not only step 2.")).toBeTruthy();
    await user.click(next());
    expect(screen.getByText("This ZIP has the final code of the whole chapter.")).toBeTruthy();
    expect(screen.queryByText(/not only step/)).toBeNull();
    expect(screen.getByRole("link", { name: "Download chapter code (ZIP)" }).getAttribute("href")).toBe("/api/courses/sample-course/chapters/01-first-steps/code.zip");
  });

  it("says nothing about steps for a chapter of one step", async () => {
    serve(withSteps([file("only.py", "added")]));
    show([steps({ step: "1" })]);
    await screen.findByRole("tablist");
    expect(screen.getByText("This ZIP has the final code of the whole chapter.")).toBeTruthy();
  });
});

describe("several viewers in one lesson", () => {
  it("keep their own step, file and Copied state, and share one request", async () => {
    const api = serve();
    const { user, container } = show([
      steps({ step: "1" }),
      component("Tabs", {}, [tab("One", paragraph(text("first tab"))), tab("Two", steps({ step: "2" }))]),
      steps({ step: "3" }),
    ]);
    await waitFor(() => expect(container.querySelectorAll(".code-steps [role=tablist]")).toHaveLength(3));

    const viewers = Array.from(container.querySelectorAll<HTMLElement>(".code-steps"));
    const first = within(viewers[0]);
    await user.click(first.getByRole("button", { name: "Next step" }));
    await user.click(first.getByRole("tab", { name: /^pkg\/util\.py/ }));
    await user.click(first.getByRole("button", { name: /^Copy/ }));

    expect(first.getByText("Step 2 of 3")).toBeTruthy();
    expect(first.getByRole("button", { name: "Copied pkg/util.py" })).toBeTruthy();
    expect(within(viewers[1]).getByText("Step 2 of 3")).toBeTruthy();
    expect(within(viewers[1]).getByRole("tab", { name: /^main\.py/, hidden: true }).getAttribute("aria-selected")).toBe("true");
    expect(within(viewers[2]).getByText("Step 3 of 3")).toBeTruthy();
    expect(within(viewers[2]).getByRole("button", { name: /^Copy main\.py/ })).toBeTruthy();
    expect(api.calls(CODE)).toHaveLength(1);

    // The viewer in the hidden tab keeps its step when it is moved while the tab is shown.
    await user.click(screen.getByRole("tab", { name: "Two" }));
    await user.click(within(viewers[1]).getByRole("button", { name: "Previous step" }));
    await user.click(screen.getByRole("tab", { name: "One" }));
    await user.click(screen.getByRole("tab", { name: "Two" }));
    expect(within(viewers[1]).getByText("Step 1 of 3")).toBeTruthy();
    expect(first.getByText("Step 2 of 3")).toBeTruthy();
    expect(within(viewers[2]).getByText("Step 3 of 3")).toBeTruthy();
    expect(api.calls()).toHaveLength(1);
  });
});

describe("the data", () => {
  it.each([
    ["a status that is not one of the four", (data: Chapter) => ((data.steps[1].files[0] as { status: string }).status = "renamed")],
    ["changed_lines that is not a list", (data: Chapter) => ((data.steps[1].files[0] as { changed_lines: unknown }).changed_lines = "1,2")],
    ["changed_lines with a text in it", (data: Chapter) => ((data.steps[1].files[0] as { changed_lines: unknown }).changed_lines = [1, "2"])],
  ])("shows the unexpected-response message and Try again for %s", async (_name, damage) => {
    serve(chapter(damage));
    show([steps({ step: "2" })]);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(UNEXPECTED_RESPONSE_MESSAGE);
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("logs nothing that holds file content while the learner moves through the steps", async () => {
    const log = spyOnConsole();
    const { user } = await open("1");
    await user.click(next());
    await user.click(next());
    await user.click(previous());
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("works under StrictMode: one request, and the step buttons move one step", async () => {
    const api = serve();
    const { user } = show([steps({ step: "1" })], { strict: true });
    await screen.findByRole("tablist");
    await user.click(next());
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
    expect(api.calls(CODE)).toHaveLength(1);
  });

  it("starts a file prop that names a deleted file on the first changed file, with a warning", async () => {
    const log = spyOnConsole();
    serve(withFiles(3, golden.steps[2].files as FileData[]));
    show([steps({ step: "3", file: "helper.py" })]);
    await screen.findByRole("tablist");
    expect(selectedPath()).toBe("main.py");
    await waitFor(() => expect(log.warn).toHaveBeenCalledTimes(1));
  });
});
