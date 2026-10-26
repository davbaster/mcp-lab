import { describe, expect, it } from "vitest";
import { checkCodeStepsProps } from "./props";

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
