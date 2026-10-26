import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { apiRoutes } from "../test/apiRoutes";
import { jsonResponse } from "../test/mockApi";
import { component, renderTree, spyOnConsole } from "../test/renderTree";
import { splitLines } from "./codeLines";
import golden from "./fixtures/chapter-code.response.json";
import { SAMPLES } from "./codeSamples";

// The real highlighter (Shiki) here, as the learner gets it.
const CODE = "GET /api/courses/sample-course/chapters/01-first-steps/code";

function showFile(path: string, content: string) {
  const data = structuredClone(golden);
  data.steps = [{ step: 1, files: [{ path, status: "added", content, changed_lines: [] }] }];
  apiRoutes({ [CODE]: () => jsonResponse(data) });
  return renderTree([component("CodeSteps", { step: "1" })], { lesson: { courseId: "sample-course", chapterId: "01-first-steps" } });
}
const codeText = () =>
  Array.from(document.querySelectorAll(".code-line-text"))
    .map((line) => line.textContent)
    .join("");

describe("the viewer with the real highlighter", () => {
  it.each(Object.entries(SAMPLES))("shows %s with colors and with exactly the text of the file", async (path, content) => {
    const log = spyOnConsole();
    const { container } = showFile(path, content);
    await screen.findByRole("region", { name: path });
    const before = Array.from(container.querySelectorAll(".code-line"));
    expect(before).toHaveLength(splitLines(content).length);
    expect(codeText()).toBe(content);

    // Plain first, then colors (the stand-in highlighter tests that order); the real one may be quick.
    await waitFor(() => expect(container.querySelector(".code-line-text > span")).not.toBeNull());

    // Same line elements, same text, same count; only the colors came.
    const after = Array.from(container.querySelectorAll(".code-line"));
    expect(after).toHaveLength(before.length);
    after.forEach((line, index) => expect(line).toBe(before[index]));
    expect(codeText()).toBe(content);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["x.py", "<script>alert(1)</script>\n"],
    ["x.md", "# Title\n</code></pre>&lt;img src=x onerror=alert(1)&gt;'\n"],
    ["x.sh", '<img src=x onerror="alert(1)">\n'],
    ["x.txt", "<script>alert(1)</script>"],
  ])("shows markup in %s as text and creates no element from it", async (path, content) => {
    const { container } = showFile(path, content);
    await screen.findByRole("region", { name: path });
    // Wait for the colors where there are any, so the check also covers the colored output.
    if (path !== "x.txt") await waitFor(() => expect(container.querySelector(".code-line-text > span")).not.toBeNull());

    expect(codeText()).toBe(content);
    expect(container.querySelector("script, img, pre, .code-line-text span:not([class^=code-])")).toBeNull();
    expect(container.querySelectorAll(".code-line")).toHaveLength(splitLines(content).length);
  });

  it("leaves a .txt file as plain text, with no color", async () => {
    const { container } = showFile("notes.txt", "def f():\n    return 'x'\n");
    await screen.findByRole("region", { name: "notes.txt" });
    await new Promise((done) => setTimeout(done, 50));
    expect(container.querySelector(".code-line-text > span")).toBeNull();
    expect(codeText()).toBe("def f():\n    return 'x'\n");
  });
});
