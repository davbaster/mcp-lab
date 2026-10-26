import { describe, expect, it } from "vitest";
import { checkCodeStepsProps, checkModel3DProps, checkVideoProps } from "./props";

describe("checkCodeStepsProps", () => {
  it.each([
    ["1", 1],
    ["2", 2],
    ["10", 10],
    ["9007199254740991", Number.MAX_SAFE_INTEGER],
  ])("accepts step %j as %d", (step, number) => {
    expect(checkCodeStepsProps({ step })).toEqual({ ok: true, value: { step: number, file: null } });
  });

  it("returns the file when there is one", () => {
    expect(checkCodeStepsProps({ step: "2", file: "src/util.py" })).toEqual({ ok: true, value: { step: 2, file: "src/util.py" } });
  });

  it.each(["0", "01", "1.5", "abc", "", " 1", "1 ", "-1", "+1", "1e3", "9007199254740993", "99999999999999999999"])(
    "rejects step %j",
    (step) => {
      expect(checkCodeStepsProps({ step }).ok).toBe(false);
    },
  );

  it.each([undefined, null, 1, 2.5, true, ["1"], {}])("rejects a step that is not a string: %j", (step) => {
    expect(checkCodeStepsProps({ step }).ok).toBe(false);
  });

  it.each(["", 1, null, ["a.py"], {}])("rejects the file %j", (file) => {
    expect(checkCodeStepsProps({ step: "1", file }).ok).toBe(false);
  });

  it("ignores a prop that is not in the schema", () => {
    expect(checkCodeStepsProps({ step: "1", onclick: "alert(1)" })).toEqual({ ok: true, value: { step: 1, file: null } });
  });

  it("never reads an inherited property as a value", () => {
    const inherited = Object.create({ step: "1", file: "x.py" }) as Record<string, unknown>;
    expect(checkCodeStepsProps(inherited).ok).toBe(false);
  });
});

describe("checkVideoProps", () => {
  const good = { src: "https://media.mcp-lab.example/a.mp4", title: "A video" };

  it("accepts a src and a title, and returns the parsed URL", () => {
    const checked = checkVideoProps(good);
    expect(checked.ok && checked.value.src.href).toBe("https://media.mcp-lab.example/a.mp4");
    expect(checked.ok && [checked.value.title, checked.value.captions, checked.value.poster]).toEqual(["A video", null, null]);
  });

  it("accepts a site path or an https URL for captions and poster", () => {
    const checked = checkVideoProps({ ...good, captions: "/api/courses/c/assets/a.vtt", poster: "https://media.mcp-lab.example/p.png" });
    expect(checked.ok && [checked.value.captions, checked.value.poster]).toEqual([
      "/api/courses/c/assets/a.vtt",
      "https://media.mcp-lab.example/p.png",
    ]);
  });

  it.each([
    [{ title: undefined }, "title"],
    [{ title: "  " }, "title"],
    [{ src: undefined }, "src"],
    [{ src: "http://media.mcp-lab.example/a.mp4" }, "src"],
    [{ src: "/api/courses/c/assets/a.mp4" }, "src"],
    [{ captions: "a.vtt" }, "captions"],
    [{ captions: 3 }, "captions"],
    [{ poster: "javascript:alert(1)" }, "poster"],
    [{ poster: null }, "poster"],
  ])("rejects %j and names %s", (change, prop) => {
    const checked = checkVideoProps({ ...good, ...change });
    expect(!checked.ok && checked.problem).toContain(prop);
  });

  it("never reads an inherited property as a value", () => {
    const inherited = Object.create(good) as Record<string, unknown>;
    expect(checkVideoProps(inherited).ok).toBe(false);
  });
});

describe("checkModel3DProps", () => {
  const good = { src: "/api/courses/c/assets/a.glb", alt: "A model", poster: "/api/courses/c/assets/p.png" };

  it("accepts site paths and an alt text", () => {
    expect(checkModel3DProps(good)).toEqual({ ok: true, value: good });
  });

  it.each([
    [{ alt: "" }, "alt"],
    [{ poster: undefined }, "poster"],
    [{ poster: "https://media.mcp-lab.example/p.png" }, "poster"],
    [{ src: "https://media.mcp-lab.example/a.glb" }, "src"],
    [{ src: "//host/a.glb" }, "src"],
  ])("rejects %j and names %s", (change, prop) => {
    const checked = checkModel3DProps({ ...good, ...change });
    expect(!checked.ok && checked.problem).toContain(prop);
  });
});
