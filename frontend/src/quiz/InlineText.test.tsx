import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InlineText } from "./InlineText";

function view(text: string) {
  const { container } = render(<p><InlineText text={text} /></p>);
  return container.querySelector("p")!;
}

describe("InlineText", () => {
  it("shows a backtick span as one code element", () => {
    const p = view("Use `@mcp.tool()` here");
    expect(p.querySelectorAll("code")).toHaveLength(1);
    expect(p.querySelector("code")?.textContent).toBe("@mcp.tool()");
    expect(p.textContent).toBe("Use @mcp.tool() here");
  });

  it.each([
    ["an unmatched backtick", "a ` b"],
    ["an empty pair", "a `` b"],
  ])("shows %s as typed, with no code element", (_name, text) => {
    const p = view(text);
    expect(p.querySelector("code")).toBeNull();
    expect(p.textContent).toBe(text);
  });

  it.each([
    ["an image tag", "'<img src=x onerror=alert(1)>'"],
    ["Markdown bold", "**bold**"],
    ["an entity", "&amp;"],
    ["a script tag", "<script>alert(1)</script>"],
  ])("shows %s literally and creates no element from it", (_name, text) => {
    const p = view(text);
    expect(p.children).toHaveLength(0);
    expect(p.textContent).toBe(text);
  });

  it("shows markup inside a span as text in the code element", () => {
    const p = view("`<img src=x onerror=alert(1)>`");
    expect(p.querySelectorAll("img")).toHaveLength(0);
    expect(p.querySelector("code")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});
