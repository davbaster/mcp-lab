import { describe, expect, it } from "vitest";
import { cleanText, codePointLength, safeText } from "./safeText";

const WELL_FORMED = /^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/;

describe("cleanText", () => {
  it("removes NUL characters", () => {
    expect(cleanText("a\u0000b\u0000")).toBe("ab");
  });

  it("replaces a lone high surrogate and a lone low surrogate with U+FFFD", () => {
    expect(cleanText("a\uD83Db")).toBe("a�b");
    expect(cleanText("a\uDE00b")).toBe("a�b");
    expect(cleanText("\uD83D")).toBe("�");
  });

  it("keeps a valid pair, and replaces a reversed pair as two lone surrogates", () => {
    expect(cleanText("😀")).toBe("😀");
    expect(cleanText("\uDE00\uD83D")).toBe("��");
  });

  it("leaves ordinary text alone", () => {
    expect(cleanText("Hello, wörld – 你好")).toBe("Hello, wörld – 你好");
  });
});

describe("codePointLength", () => {
  it("counts an emoji once", () => {
    expect(codePointLength("a😀b")).toBe(3);
    expect(codePointLength("")).toBe(0);
  });
});

describe("safeText", () => {
  it("returns a short string as it is", () => {
    expect(safeText("abc", 500)).toBe("abc");
  });

  it("cuts by code points, so an emoji at the end is never split", () => {
    const cut = safeText("😀".repeat(600), 500);

    expect(codePointLength(cut)).toBe(500);
    expect(cut.length).toBe(1000);
    expect(WELL_FORMED.test(cut)).toBe(true);
  });

  it("does not cut a string of exactly the limit", () => {
    const text = `${"a".repeat(499)}😀`;

    expect(safeText(text, 500)).toBe(text);
  });

  it("keeps an emoji that would start at the limit out, whole", () => {
    expect(safeText(`${"a".repeat(499)}😀😀`, 500)).toBe(`${"a".repeat(499)}😀`);
  });

  it("cleans before it cuts, so removed NULs do not count", () => {
    expect(safeText(`${"\u0000".repeat(50)}${"a".repeat(10)}`, 10)).toBe("a".repeat(10));
  });

  it("never returns a lone surrogate or a NUL, even from odd input", () => {
    const odd = safeText(`x\uD83D${"y".repeat(10)}\u0000\uDE00`, 8);

    expect(WELL_FORMED.test(odd)).toBe(true);
    expect(odd).not.toContain("\u0000");
  });
});
