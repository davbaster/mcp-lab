import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { link, paragraph, renderTree } from "../test/renderTree";
import { classifyLink, siteSource } from "./urls";

/** Clicks a link without letting jsdom navigate, and says whether the router handled the click. */
async function click(user: ReturnType<typeof renderTree>["user"], anchor: HTMLElement): Promise<boolean> {
  let handledByRouter = false;
  const onClick = (event: MouseEvent) => {
    // The router's Link has called preventDefault by now; a plain anchor has not.
    handledByRouter = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener("click", onClick);
  await user.click(anchor);
  document.removeEventListener("click", onClick);
  return handledByRouter;
}

function renderLink(url: unknown, title?: string) {
  return renderTree([paragraph(link(url, "the link", title))]);
}

const origin = window.location.origin;

describe("in-app links", () => {
  it.each([
    ["/courses/c/lessons/l", "/courses/c/lessons/l"],
    ["/", "/"],
    ["/courses/c?tab=1#top", "/courses/c?tab=1#top"],
    [`${origin}/courses/c/lessons/l?x=1#y`, "/courses/c/lessons/l?x=1#y"],
    [" /courses/c", "/courses/c"],
    ["/courses/\tc", "/courses/c"],
  ])("opens %j in the app, as %s", async (url, href) => {
    const { user } = renderLink(url);
    const anchor = screen.getByRole("link", { name: "the link" });
    expect(anchor.getAttribute("href")).toBe(href);
    expect(anchor.hasAttribute("target")).toBe(false);
    expect(await click(user, anchor)).toBe(true);
  });
});

describe("plain links", () => {
  it.each([
    ["/api/courses/c/assets/file.pdf", "/api/courses/c/assets/file.pdf"],
    ["/API/x", "/API/x"],
    ["/api", "/api"],
    [`${origin}/api/courses/c/assets/f.pdf`, "/api/courses/c/assets/f.pdf"],
    ["mailto:ada@example.com", "mailto:ada@example.com"],
    ["MAILTO:ada@example.com", "MAILTO:ada@example.com"],
    ["#section", "#section"],
    ["?tab=2", "?tab=2"],
  ])("renders %j as an <a href> the router does not handle", async (url, href) => {
    const { user } = renderLink(url);
    const anchor = screen.getByRole("link", { name: "the link" });
    expect(anchor.getAttribute("href")).toBe(href);
    expect(anchor.hasAttribute("target")).toBe(false);
    expect(await click(user, anchor)).toBe(false);
  });
});

describe("external links", () => {
  it.each(["https://example.com/a?b=1#c", "http://example.com/", "HTTPS://Example.com/x"])(
    "opens %s in a new tab with noopener noreferrer",
    (url) => {
      renderLink(url);
      const anchor = screen.getByRole("link", { name: "the link" });
      expect(anchor.getAttribute("href")).toBe(new URL(url).href);
      expect(anchor.getAttribute("target")).toBe("_blank");
      expect(anchor.getAttribute("rel")).toBe("noopener noreferrer");
    },
  );
});

describe("links that are only text", () => {
  it.each([
    "../a.md",
    "images/pic.png",
    "a.md",
    "./a",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "JAVASCRIPT:alert(1)",
    " javascript:alert(1)",
    "\tjavascript:alert(1)",
    "\n javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "java\r\nscript:alert(1)",
    "\u0001javascript:alert(1)",
    "jav&#x09;ascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "DATA:text/html;base64,AAAA",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "ftp://example.com/x",
    "//evil.example/x",
    "/\\evil.example/x",
    "\\\\evil.example\\x",
    "",
    "   ",
  ])("shows only the text for %j", (url) => {
    const { container } = renderLink(url);
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("p")?.textContent).toBe("the link");
  });

  it.each([null, undefined, 42, { href: "/x" }, ["/x"]])("shows only the text when the url is %j", (url) => {
    const { container } = renderLink(url);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("the link");
  });
});

describe("link titles", () => {
  it("becomes the title attribute", () => {
    renderLink("/courses/c", "Go there");
    expect(screen.getByRole("link").getAttribute("title")).toBe("Go there");
  });

  it("is left out when it is empty or not a string", () => {
    renderLink("https://example.com", "");
    expect(screen.getByRole("link").hasAttribute("title")).toBe(false);
  });
});

describe("classifyLink and siteSource", () => {
  it("never returns the cleaned-away characters in an href", () => {
    expect(classifyLink("  /courses/\tx\n")).toEqual({ kind: "app", to: "/courses/x" });
  });

  it("treats an unparseable http url as text", () => {
    expect(classifyLink("http://")).toEqual({ kind: "text" });
  });

  it.each(["/api/courses/c/assets/a.png", "/x", "/a/b?c=d"])("accepts %s as a source", (url) => {
    expect(siteSource(url)).toBe(url);
  });

  it.each([
    "//host/x",
    "/\\host/x",
    "http://host/x",
    "https://host/x",
    "data:image/png;base64,AA",
    "javascript:alert(1)",
    "x.png",
    "",
    "/a b",
    "/a\tb",
    "/a\nb",
    null,
    7,
  ])("refuses %j as a source", (url) => {
    expect(siteSource(url)).toBeNull();
  });
});
