// The compiler checks its own output against the tree schema before it returns it.

import { describe, expect, it, vi } from "vitest";

const treeErrors = vi.hoisted(() => vi.fn<(tree: unknown) => string[]>(() => []));

vi.mock("../src/lesson-tree.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lesson-tree.ts")>()),
  treeErrors,
}));

const { compileLesson } = await import("../src/lesson.ts");

const LESSON = "---\ntitle: T\norder: 1\n---\n\nHello\n";

describe("compileLesson checks its own output", () => {
  it("passes the finished tree to the check before it returns it", () => {
    const result = compileLesson(LESSON, { path: "l.mdx" });

    expect(result).toHaveProperty("tree");
    expect(treeErrors).toHaveBeenCalledTimes(1);
    expect(treeErrors).toHaveBeenCalledWith({
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: "Hello" }] }],
    });
  });

  it("throws an internal error, and returns no tree, when the output does not match the schema", () => {
    treeErrors.mockReturnValueOnce(["/children/0 must be object"]);

    expect(() => compileLesson(LESSON, { path: "l.mdx" })).toThrow(
      "internal error: the compiled tree does not match lesson-tree.schema.json: /children/0 must be object",
    );
  });

  it("does not check a lesson that was rejected, since it has no tree", () => {
    treeErrors.mockClear();

    expect(compileLesson("---\ntitle: T\norder: 1\n---\n\n{1}\n", { path: "l.mdx" })).toHaveProperty("problems");
    expect(treeErrors).not.toHaveBeenCalled();
  });
});
