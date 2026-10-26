import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../test/apiRoutes";
import { component, renderTree, spyOnConsole, tab } from "../test/renderTree";
import { CodeBlock } from "./CodeBlock";
import { splitLines } from "./codeLines";
import { highlight, MAX_HIGHLIGHT_CHARS } from "./highlighter";

// The real highlighter is tested in highlighter.test.ts and CodeBlock.highlight.test.tsx. Here it
// is a stand-in that colors every line, so these tests are fast and can hold the colors back.
vi.mock("./highlighter", async (importOriginal) => ({ ...(await importOriginal<typeof import("./highlighter")>()), highlight: vi.fn() }));

type Colors = Awaited<ReturnType<typeof highlight>>;

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

const fence = (lang: string | undefined, value: string) => ({ type: "code", ...(lang !== undefined && { lang }), value });
const blocks = (container: ParentNode = document) => Array.from(container.querySelectorAll("pre"));
const codeOf = (pre: Element) => pre.querySelector("code") as HTMLElement;
const copyButton = (name: RegExp | string = /^Cop(y|ied)/) => screen.getByRole("button", { name });
const label = (name: RegExp | string = /^Cop(y|ied)/) => copyButton(name).textContent?.trim();

describe("a lesson fence with a known language", () => {
  it("is plain text first, then gets colors in the same pre and code, with the same text", async () => {
    const colors = deferred<Colors>();
    vi.mocked(highlight).mockReturnValue(colors.promise);
    const { container } = renderTree([fence("python", "def f():\n\treturn 1\n")]);
    const [pre] = blocks(container);
    const code = codeOf(pre);
    expect(code.textContent).toBe("def f():\n\treturn 1\n");
    expect(code.children).toHaveLength(0);
    await waitFor(() => expect(highlight).toHaveBeenCalledWith("def f():\n\treturn 1\n", "python"));

    await act(async () => {
      colors.resolve([[{ text: "def", className: "code-token-keyword" }, { text: " f():", className: null }], [{ text: "\treturn 1", className: null }]]);
    });

    expect(blocks(container)).toHaveLength(1);
    expect(blocks(container)[0]).toBe(pre);
    expect(pre.querySelector("code")).toBe(code);
    expect(code.textContent).toBe("def f():\n\treturn 1\n");
    expect(Array.from(code.children).map((child) => `${child.tagName} ${child.className}`)).toEqual(["SPAN code-token-keyword"]);
    expect(code.className).toBe("language-python");
  });

  it("passes the grammar that the language name maps to, in any letter case", async () => {
    renderTree([fence("py", "a"), fence("YAML", "b"), fence("Bash", "c"), fence("md", "d"), fence("JSON", "e"), fence("toml", "f")]);
    await waitFor(() => expect(highlight).toHaveBeenCalledTimes(6));
    expect(vi.mocked(highlight).mock.calls).toEqual([
      ["a", "python"],
      ["b", "yaml"],
      ["c", "shellscript"],
      ["d", "markdown"],
      ["e", "json"],
      ["f", "toml"],
    ]);
  });

  it("keeps the language class exactly as written", () => {
    const { container } = renderTree([fence("Python", "a")]);
    expect(codeOf(blocks(container)[0]).className).toBe("language-Python");
  });

  it("adds no element but spans with token classes, and keeps a final newline, an empty line and an empty last line", async () => {
    const value = "a = 1\n\n\n";
    const { container } = renderTree([fence("python", value)]);
    const code = codeOf(blocks(container)[0]);
    await waitFor(() => expect(code.querySelector("span")).not.toBeNull());

    expect(code.textContent).toBe(value);
    for (const child of Array.from(code.querySelectorAll("*"))) {
      expect(child.tagName).toBe("SPAN");
      expect(child.className).toMatch(/^code-(token-[a-z-]+|italic|bold|underline)/);
    }
  });

  it("shows markup as text in a Python block and a plain block, and creates no element from it", async () => {
    const values = ["<script>alert(1)</script>", "</code></pre><img src=x onerror=alert(1)>", "&amp; &lt;b&gt;"];
    const { container } = renderTree([...values.map((value) => fence("python", value)), ...values.map((value) => fence(undefined, value))]);
    await waitFor(() => expect(container.querySelectorAll(".code-token-keyword")).toHaveLength(3));

    expect(blocks(container).map((pre) => pre.textContent)).toEqual([...values, ...values]);
    expect(container.querySelector("script, img, .lesson-content > pre")).toBeNull();
    expect(container.querySelectorAll("pre")).toHaveLength(6);
    expect(container.querySelectorAll("code > :not(span)")).toHaveLength(0);
  });
});

describe("a fence that is not highlighted", () => {
  it.each([
    ["no language", undefined],
    ["an unknown language", "javascript"],
    ["a close name", "python3"],
    ["a name with a space", "py thon"],
    ["a name with markup", '"><img src=x>'],
    ["an empty name", ""],
  ])("stays plain text with %s, without asking the highlighter or logging", async (_name, lang) => {
    const log = spyOnConsole();
    const { container } = renderTree([fence(lang, "x = 1\n")]);
    await new Promise((done) => setTimeout(done, 20));

    expect(highlight).not.toHaveBeenCalled();
    expect(codeOf(blocks(container)[0]).textContent).toBe("x = 1\n");
    expect(container.querySelector("code > *")).toBeNull();
    expect(container.querySelector("[role=alert], .error-box, .content-unavailable")).toBeNull();
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("renders an empty fence as an empty pre and code, asks for no colors, and copies the empty string", async () => {
    const { container, user } = renderTree([fence("python", "")]);
    await new Promise((done) => setTimeout(done, 20));
    expect(highlight).not.toHaveBeenCalled();
    expect(blocks(container)).toHaveLength(1);
    expect(codeOf(blocks(container)[0]).textContent).toBe("");

    const write = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(copyButton());

    // The clipboard stub has no text item for an empty string, so the call is what is checked.
    expect(write).toHaveBeenCalledExactlyOnceWith("");
    expect(label()).toBe("Copied python code");
  });

  it("stays plain text, with Copy working and no message, when the highlighter gives nothing", async () => {
    const log = spyOnConsole();
    vi.mocked(highlight).mockResolvedValue(null);
    const { container, user } = renderTree([fence("python", "a = 1\n")]);
    await waitFor(() => expect(highlight).toHaveBeenCalled());
    await new Promise((done) => setTimeout(done, 20));

    expect(codeOf(blocks(container)[0]).textContent).toBe("a = 1\n");
    expect(container.querySelector("code > *")).toBeNull();
    await user.click(copyButton());
    expect(await navigator.clipboard.readText()).toBe("a = 1\n");
    expect(log.error).not.toHaveBeenCalled();
  });

  it("ignores colors whose line count does not match the text", async () => {
    vi.mocked(highlight).mockResolvedValue([[{ text: "WRONG", className: "code-token-keyword" }]]);
    const { container } = renderTree([fence("python", "a\nb\n")]);
    await waitFor(() => expect(highlight).toHaveBeenCalled());
    await new Promise((done) => setTimeout(done, 20));
    expect(codeOf(blocks(container)[0]).textContent).toBe("a\nb\n");
  });

  it("asks for no colors for more than 100,000 characters, and does for exactly 100,000", async () => {
    const { container } = renderTree([fence("python", "x".repeat(MAX_HIGHLIGHT_CHARS + 1))]);
    await new Promise((done) => setTimeout(done, 20));
    expect(highlight).not.toHaveBeenCalled();
    expect(codeOf(blocks(container)[0]).textContent).toHaveLength(MAX_HIGHLIGHT_CHARS + 1);
    cleanup();

    renderTree([fence("python", "x".repeat(MAX_HIGHLIGHT_CHARS))]);
    await waitFor(() => expect(highlight).toHaveBeenCalledTimes(1));
  });

  it("does not let one block that fails or is too big change another block", async () => {
    vi.mocked(highlight).mockImplementation(async (content) => (content === "bad" ? null : splitLines(content).map((line) => [{ text: line.text, className: "code-token-keyword" }])));
    const { container } = renderTree([fence("python", "good = 1"), fence("python", "bad"), fence("python", "x".repeat(MAX_HIGHLIGHT_CHARS + 1)), fence(undefined, "bare")]);
    await waitFor(() => expect(container.querySelectorAll(".code-token-keyword")).toHaveLength(1));
    await new Promise((done) => setTimeout(done, 20));

    const [good, bad, big, bare] = blocks(container);
    expect(good.querySelector(".code-token-keyword")?.textContent).toBe("good = 1");
    for (const plain of [bad, big, bare]) expect(plain.querySelector("code > *")).toBeNull();
    expect(bad.textContent).toBe("bad");
    expect(bare.textContent).toBe("bare");
  });

  it("is highlighted inside a Callout and inside a Tab, with its own Copy button", async () => {
    const { container } = renderTree([
      component("Callout", { type: "note" }, [fence("python", "in_callout = 1")]),
      component("Tabs", {}, [tab("One", fence("json", '{"in": "tab"}'))]),
    ]);
    await waitFor(() => expect(container.querySelectorAll(".code-token-keyword")).toHaveLength(2));

    const callout = container.querySelector(".callout") as HTMLElement;
    const panel = screen.getByRole("tabpanel");
    expect(within(callout).getByRole("button", { name: "Copy python code" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Copy json code" })).toBeTruthy();
    expect(within(panel).getByRole("region", { name: "json code block" })).toBeTruthy();
  });
});

describe("a block whose props change", () => {
  it("never shows the old colors over the new text", async () => {
    const first = deferred<Colors>();
    const second = deferred<Colors>();
    vi.mocked(highlight).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender } = render(<CodeBlock code="old = 1" language="python" label="Code" />);
    const pre = screen.getByRole("region", { name: "Code" });
    await waitFor(() => expect(highlight).toHaveBeenCalledTimes(1));

    rerender(<CodeBlock code="new = 2" language="python" label="Code" />);
    await waitFor(() => expect(highlight).toHaveBeenCalledTimes(2));
    await act(async () => {
      first.resolve([[{ text: "old = 1", className: "code-token-keyword" }]]);
    });
    expect(pre.textContent).toBe("new = 2");
    expect(pre.querySelector("span")).toBeNull();

    await act(async () => {
      second.resolve([[{ text: "new = 2", className: "code-token-string" }]]);
    });
    expect(pre.textContent).toBe("new = 2");
    expect(pre.querySelector(".code-token-string")?.textContent).toBe("new = 2");
    expect(screen.getByRole("region", { name: "Code" })).toBe(pre);
  });

  it("drops the colors and asks for none when the language is no longer known", async () => {
    const { rerender } = render(<CodeBlock code="a = 1" language="python" label="Code" />);
    await waitFor(() => expect(document.querySelector(".code-token-keyword")).not.toBeNull());

    rerender(<CodeBlock code="a = 1" language="text" label="Code" />);

    await waitFor(() => expect(document.querySelector(".code-token-keyword")).toBeNull());
    expect(highlight).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("region", { name: "Code" }).textContent).toBe("a = 1");
  });

  it("changes nothing on screen when it is unmounted before the highlighter answers", async () => {
    const log = spyOnConsole();
    const colors = deferred<Colors>();
    vi.mocked(highlight).mockReturnValue(colors.promise);
    const { unmount } = render(<CodeBlock code="a = 1" language="python" label="Code" />);
    await waitFor(() => expect(highlight).toHaveBeenCalled());

    unmount();
    await act(async () => {
      colors.resolve([[{ text: "a = 1", className: "code-token-keyword" }]]);
    });

    expect(document.body.textContent).toBe("");
    expect(log.error).not.toHaveBeenCalled();
  });

  it("keeps one pre and shows the colors once under StrictMode", async () => {
    const { container } = renderTree([fence("python", "a = 1")], { strict: true });
    await waitFor(() => expect(container.querySelector(".code-token-keyword")).not.toBeNull());
    expect(blocks(container)).toHaveLength(1);
    expect(container.querySelectorAll(".code-token-keyword")).toHaveLength(1);
    expect(blocks(container)[0].textContent).toBe("a = 1");
  });
});

describe("a quiz-style block (no Copy button)", () => {
  it("is a bare pre with the given class and name, colored through the same highlighter", async () => {
    const { container } = render(<CodeBlock code={"x = 1\n"} language="python" label="Code for question 1" className="quiz-snippet" />);
    const pre = screen.getByRole("region", { name: "Code for question 1" });
    expect(pre.tagName).toBe("PRE");
    expect(pre.className).toBe("quiz-snippet");
    expect(pre.tabIndex).toBe(0);
    expect(container.querySelector("button")).toBeNull();
    expect(pre.querySelector("code")?.hasAttribute("class")).toBe(false);

    await waitFor(() => expect(pre.querySelector(".code-token-keyword")).not.toBeNull());
    expect(pre.textContent).toBe("x = 1\n");
  });
});

describe("the Copy button of a lesson fence", () => {
  it("sits before the pre, outside it, in a toolbar", () => {
    const { container } = renderTree([fence("python", "a")]);
    const toolbar = container.querySelector(".code-toolbar") as HTMLElement;
    const pre = blocks(container)[0];
    expect(toolbar.contains(copyButton())).toBe(true);
    expect(pre.contains(copyButton())).toBe(false);
    expect(toolbar.compareDocumentPosition(pre) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toolbar.parentElement).toBe(pre.parentElement);
  });

  it("is on a plain block and on an empty block too", () => {
    renderTree([fence(undefined, "plain"), fence("zsh", "z"), fence("python", "")]);
    expect(screen.getAllByRole("button", { name: /^Copy/ })).toHaveLength(3);
  });

  it("copies the value from the tree: indentation, tabs, blank lines and a trailing newline", async () => {
    const value = "def f():\n    x = 1\n\n\treturn x\n";
    const { user } = renderTree([fence("python", value)]);
    await waitFor(() => expect(document.querySelector(".code-token-keyword")).not.toBeNull());

    await user.click(copyButton());

    expect(await navigator.clipboard.readText()).toBe(value);
  });

  it("copies a value without a final newline as it is", async () => {
    const { user } = renderTree([fence(undefined, "no newline")]);
    await user.click(copyButton());
    expect(await navigator.clipboard.readText()).toBe("no newline");
  });

  it("copies the tree's text even if the highlighter's text differs", async () => {
    vi.mocked(highlight).mockResolvedValue([[{ text: "WRONG", className: null }]]);
    const { user } = renderTree([fence("python", "right")]);
    await waitFor(() => expect(highlight).toHaveBeenCalled());
    await user.click(copyButton());
    expect(await navigator.clipboard.readText()).toBe("right");
  });

  it("is named Copy plus the language as written, or Copy code, and starts with the visible text", () => {
    renderTree([fence("python", "a"), fence("C#", "b"), fence(undefined, "c"), fence("py thon", "d"), fence("", "e")]);
    const buttons = screen.getAllByRole("button", { name: /^Copy/ });
    expect(buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim())).toEqual([
      "Copy python code",
      "Copy C# code",
      "Copy code",
      "Copy code",
      "Copy code",
    ]);
    for (const button of buttons) {
      expect(button.firstChild?.textContent).toBe("Copy");
      expect(button.querySelector(".visually-hidden")).not.toBeNull();
    }
    expect(screen.getByRole("button", { name: "Copy python code" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy C# code" })).toBeTruthy();
  });

  it("is a secondary button in a polite live region that was there before the first press", async () => {
    const { user } = renderTree([fence("python", "a")]);
    const region = copyButton().closest("[aria-live]");
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(copyButton().className).toBe("button button-secondary");
    expect(copyButton().getAttribute("type")).toBe("button");

    await user.click(copyButton());

    expect(screen.getByRole("button", { name: /^Copied/ }).closest("[aria-live]")).toBe(region);
  });

  it("keeps its own Copied state for each block", async () => {
    const { user } = renderTree([fence("python", "one"), fence("python", "two")]);
    const [first, second] = screen.getAllByRole("button", { name: /^Copy/ });

    await user.click(first);

    expect(first.textContent?.trim()).toBe("Copied python code");
    expect(second.textContent?.trim()).toBe("Copy python code");
    expect(await navigator.clipboard.readText()).toBe("one");
  });

  describe("with a clock", () => {
    async function ready(nodes: unknown[] = [fence("python", "a = 1")]) {
      const view = renderTree(nodes);
      await waitFor(() => expect(highlight).toHaveBeenCalled());
      vi.useFakeTimers();
      return view;
    }
    const press = async () => {
      await act(async () => {
        fireEvent.click(copyButton());
      });
    };
    const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

    it("reads Copied for 2 seconds, then Copy", async () => {
      await ready();
      expect(label()).toBe("Copy python code");

      await press();
      expect(label()).toBe("Copied python code");
      await wait(1999);
      expect(label()).toBe("Copied python code");
      await wait(1);
      expect(label()).toBe("Copy python code");
    });

    it("starts the 2 seconds again when it is pressed again at 1.5 seconds", async () => {
      await ready();
      await press();
      await wait(1500);
      await press();
      await wait(1999);
      expect(label()).toBe("Copied python code");
      await wait(1);
      expect(label()).toBe("Copy python code");
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

    it("keeps the failure message until the next press, however long it waits, and tries again", async () => {
      const log = spyOnConsole();
      await ready();
      const write = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new DOMException("Not allowed", "NotAllowedError"));

      await press();
      expect(copyButton().textContent).toBe("Copy failed – select the code to copy it");
      await wait(60_000);
      expect(copyButton().textContent).toBe("Copy failed – select the code to copy it");
      expect(log.error).not.toHaveBeenCalled();

      await press();
      expect(label()).toBe("Copied python code");
      expect(write).toHaveBeenCalledTimes(2);
    });
  });

  it("says Copy failed when navigator.clipboard is missing, crashes nothing and logs no error", async () => {
    const log = spyOnConsole();
    const { user, container } = renderTree([fence(undefined, "a")]);
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    try {
      await user.click(copyButton());
      expect(screen.getByRole("button", { name: "Copy failed – select the code to copy it" })).toBeTruthy();
      expect(blocks(container)[0].textContent).toBe("a");
      expect(log.error).not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
    }
  });
});

describe("keyboard and names", () => {
  it("has the Copy button, then the pre, in the Tab order, and the pre shows it has focus", async () => {
    const { user } = renderTree([fence("python", "a"), fence(undefined, "b")]);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy python code" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "python code block" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy code" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Code block" }));
  });

  it("names each block's region by its language as written, or Code block, and never by the code", () => {
    renderTree([fence("python", "SECRET = 1"), fence("Bash", "ls"), fence(undefined, "x"), fence("a b", "y")]);
    const regions = screen.getAllByRole("region");
    expect(regions.map((region) => region.getAttribute("aria-label"))).toEqual(["python code block", "Bash code block", "Code block", "Code block"]);
    for (const region of regions) expect(region.tabIndex).toBe(0);
    expect(regions[0].getAttribute("aria-label")).not.toContain("SECRET");
  });

  it("lets the learner select the code by hand: nothing is user-select none and there are no markers in the text", () => {
    const { container } = renderTree([fence("python", "a = 1\nb = 2")]);
    expect(container.querySelector("pre")?.textContent).toBe("a = 1\nb = 2");
    expect(container.querySelector("pre [aria-hidden], pre .code-line-number, pre .visually-hidden")).toBeNull();
  });
});
