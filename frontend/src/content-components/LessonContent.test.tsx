import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import allAssets from "./fixtures/all-assets.tree.json";
import markdown from "./fixtures/markdown.tree.json";
import { component, heading, link, paragraph, renderTree, spyOnConsole, tab, text } from "../test/renderTree";

const markdownNodes = markdown.children as unknown[];
const allAssetsNodes = allAssets.children as unknown[];

function find(container: HTMLElement, selector: string): Element[] {
  return Array.from(container.querySelectorAll(selector));
}

describe("Markdown nodes", () => {
  it("renders each node type of the Markdown golden tree as its HTML element", () => {
    const { container } = renderTree(markdownNodes, { title: "Another title" });

    // The first depth-1 heading does not repeat the title here, so it is shown, as an h2.
    expect(find(container, "h2").map((h) => h.textContent)).toEqual(["Heading one", "Heading two"]);
    expect(find(container, "h3").map((h) => h.textContent)).toEqual(["Heading three"]);
    expect(find(container, "h4").map((h) => h.textContent)).toEqual(["Heading four"]);
    expect(find(container, "h5").map((h) => h.textContent)).toEqual(["Heading five"]);
    expect(find(container, "h6").map((h) => h.textContent)).toEqual(["Heading six"]);
    expect(find(container, "p em").map((e) => e.textContent)).toEqual(["emphasis"]);
    // One in the paragraph, one in the block quote.
    expect(find(container, "p strong").map((e) => e.textContent)).toEqual(["strong text", "strong text"]);
    expect(find(container, "p > code").map((e) => e.textContent)).toEqual(["inline code"]);
    expect(find(container, "p br")).toHaveLength(1);
    expect(find(container, "blockquote p")).toHaveLength(2);
    expect(find(container, "hr")).toHaveLength(1);
    expect(find(container, "ul")).toHaveLength(2);
    expect(find(container, "ol")).toHaveLength(2);
    expect(find(container, "li").length).toBe(9);
  });

  it("renders a link with its title attribute", () => {
    renderTree(markdownNodes);
    const anchor = screen.getByRole("link", { name: "link" });
    expect(anchor.getAttribute("href")).toBe("https://example.com/a");
    expect(anchor.getAttribute("title")).toBe("A title");
  });

  it("keeps the text on both sides of a hard break", () => {
    const { container } = renderTree(markdownNodes);
    const br = container.querySelector("br") as Element;
    expect(br.previousSibling?.textContent).toBe("Two lines end with a hard break");
    expect(br.nextSibling?.textContent).toBe("and continue here.");
  });

  it("renders an ordered list at its start number and an unordered list without one", () => {
    const { container } = renderTree(markdownNodes);
    const starts = find(container, "ol").map((ol) => ol.getAttribute("start"));
    expect(starts).toEqual(["3", "1"]);
    for (const ul of find(container, "ul")) expect(ul.hasAttribute("start")).toBe(false);
  });

  it("renders nested lists and a block quote inside a list item nested", () => {
    const { container } = renderTree([
      {
        type: "list",
        ordered: true,
        start: 5,
        children: [
          {
            type: "listItem",
            children: [
              paragraph(text("outer")),
              { type: "list", ordered: false, children: [{ type: "listItem", children: [paragraph(text("inner"))] }] },
              { type: "blockquote", children: [paragraph(text("quoted"))] },
            ],
          },
        ],
      },
    ]);
    expect(container.querySelector("ol[start='5'] > li > ul > li")?.textContent).toBe("inner");
    expect(container.querySelector("ol > li > blockquote > p")?.textContent).toBe("quoted");
  });

  it("renders a fenced code block as pre and code with a language class and a keyboard stop", () => {
    const { container } = renderTree(markdownNodes);
    const blocks = find(container, "pre");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].getAttribute("tabindex")).toBe("0");
    expect(blocks[0].querySelector("code")?.className).toBe("language-python");
    expect(blocks[0].textContent).toBe('print("hello")');
    expect(blocks[1].querySelector("code")?.hasAttribute("class")).toBe(false);
    expect(blocks[1].textContent).toBe("no language here");
  });

  it.each(["c++", "C#", "objective-c", "x.y_z", "py3"])("accepts the code language %s", (lang) => {
    const { container } = renderTree([{ type: "code", lang, value: "x" }]);
    expect(container.querySelector("code")?.className).toBe(`language-${lang}`);
  });

  it.each(['py thon', '"><img src=x>', "a/b", "", "x\ny"])("adds no class for the code language %j", (lang) => {
    const { container } = renderTree([{ type: "code", lang, value: "x" }]);
    expect(container.querySelector("code")?.hasAttribute("class")).toBe(false);
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders an empty tree as an empty body", () => {
    const { container } = renderTree([]);
    expect(container.querySelector(".lesson-content")?.childNodes).toHaveLength(0);
  });
});

describe("headings", () => {
  it("does not render a first depth-1 heading that repeats the title", () => {
    const { container } = renderTree([heading(1, "The title"), paragraph(text("Body")), heading(2, "Part")], {
      title: "The title",
    });
    expect(container.querySelector("h1")).toBeNull();
    expect(find(container, "h2").map((h) => h.textContent)).toEqual(["Part"]);
    expect(screen.getByText("Body")).toBeTruthy();
  });

  it("compares the text of the descendants, trimmed", () => {
    const first = {
      type: "heading",
      depth: 1,
      children: [text("  The "), { type: "strong", children: [text("title")] }, { type: "inlineCode", value: " " }],
    };
    const { container } = renderTree([first, paragraph(text("Body"))], { title: "The title" });
    expect(container.querySelector("h2")).toBeNull();
    expect(container.querySelector("strong")).toBeNull();
  });

  it("renders a first depth-1 heading with other text as h2", () => {
    const { container } = renderTree([heading(1, "Something else")], { title: "The title" });
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("h2")?.textContent).toBe("Something else");
  });

  it("renders a depth-1 heading that is not first as h2, even when it repeats the title", () => {
    const { container } = renderTree([paragraph(text("Intro")), heading(1, "The title")], { title: "The title" });
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("h2")?.textContent).toBe("The title");
  });

  it("shows a first heading of depth 2 as it is", () => {
    const { container } = renderTree([heading(2, "The title")], { title: "The title" });
    expect(container.querySelector("h2")?.textContent).toBe("The title");
  });

  it("drops only the first node, not a second heading that repeats the title", () => {
    const { container } = renderTree([heading(1, "The title"), heading(1, "The title")], { title: "The title" });
    expect(find(container, "h2")).toHaveLength(1);
  });

  it("skips a heading with a depth outside 1 to 6 and logs it", () => {
    const log = spyOnConsole();
    const { container } = renderTree([heading(7, "Deep"), heading(0, "Zero"), paragraph(text("Rest"))]);
    expect(container.querySelector("h2, h3, h4, h5, h6, h7")).toBeNull();
    expect(screen.getByText("Rest")).toBeTruthy();
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});

describe("Markdown images", () => {
  it("renders src, alt, title and lazy loading", () => {
    const { container } = renderTree([
      paragraph({ type: "image", url: "/api/courses/c/assets/photo-1.jpg", alt: "A photo", title: "A title" }),
    ]);
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/api/courses/c/assets/photo-1.jpg");
    expect(img.getAttribute("alt")).toBe("A photo");
    expect(img.getAttribute("title")).toBe("A title");
    expect(img.getAttribute("loading")).toBe("lazy");
  });

  it("keeps an empty alt empty and adds no title", () => {
    const { container } = renderTree([paragraph({ type: "image", url: "/api/courses/c/assets/a.png", alt: "" })]);
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("alt")).toBe("");
    expect(img.hasAttribute("title")).toBe(false);
  });

  it.each([
    "http://example.com/a.png",
    "https://example.com/a.png",
    "data:image/png;base64,AAAA",
    "//host.example/x.png",
    "/\\host.example/x.png",
    "images/pic.png",
    "javascript:alert(1)",
    "/with space.png",
  ])("does not use %s as a source and shows the alt text only", (url) => {
    const { container } = renderTree([paragraph(text("Before "), { type: "image", url, alt: "The alt" })]);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("p")?.textContent).toBe("Before The alt");
  });

  it("replaces an image that fails to load with its alt text, and nothing for a decorative one", () => {
    const { container } = renderTree([
      paragraph({ type: "image", url: "/api/a.png", alt: "Broken one" }, { type: "image", url: "/api/b.png", alt: "" }),
    ]);
    const images = find(container, "img");
    expect(images).toHaveLength(2);
    images.forEach((img) => fireEvent.error(img));
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Broken one")).toBeTruthy();
    expect(container.querySelector("p")?.textContent).toBe("Broken one");
  });

  it("gives the real build output's images (an unbuilt relative one included) the right treatment", () => {
    const { container } = renderTree(allAssetsNodes);
    expect(container.querySelector("img[alt='A photo']")?.getAttribute("src")).toMatch(/^\/api\/courses\/sample-course\/assets\//);
    // The link to "images/pic.png" is a relative link: its text only.
    expect(screen.queryByRole("link", { name: "a file" })).toBeNull();
    expect(screen.getByText(/a file/)).toBeTruthy();
  });
});

describe("author text is always text", () => {
  const XSS = "<script>alert(1)</script> &lt;img src=x onerror=alert(1)&gt;";

  const nodes = [
    paragraph(text(`Paragraph ${XSS}`)),
    paragraph({ type: "inlineCode", value: `inline ${XSS}` }),
    { type: "code", lang: "text", value: `block ${XSS}` },
    heading(2, `Heading ${XSS}`),
    paragraph(link("https://example.com/", `Link text ${XSS}`, `Link title ${XSS}`)),
    paragraph({ type: "image", url: "/api/a.png", alt: `Md alt ${XSS}`, title: `Md title ${XSS}` }),
    component("Callout", { type: "note", title: `Callout title ${XSS}` }, [paragraph(text("In callout"))]),
    component("Tabs", {}, [tab(`Tab one ${XSS}`, paragraph(text("One"))), tab("Tab two", paragraph(text("Two")))]),
    component("Image", { src: "/api/b.png", alt: `Image alt ${XSS}` }),
    component("Diagram", { src: "/api/c.svg", alt: `Diagram alt ${XSS}` }),
  ];

  it("shows the characters literally and creates no script element", () => {
    const { container } = renderTree(nodes);

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img[src='x']")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    for (const prefix of ["Paragraph", "inline", "block", "Heading", "Link text", "Callout title", "Tab one"]) {
      expect(container.textContent).toContain(`${prefix} ${XSS}`);
    }
    expect(container.querySelector("code")?.textContent).toBe(`inline ${XSS}`);
    expect(container.querySelector("pre")?.textContent).toBe(`block ${XSS}`);
    expect(screen.getByRole("heading", { level: 2, name: `Heading ${XSS}` })).toBeTruthy();
    expect(screen.getByRole("tab", { name: `Tab one ${XSS}` })).toBeTruthy();
  });

  it("puts it in attributes as attribute text", () => {
    const { container } = renderTree(nodes);

    expect(container.querySelector("a[title]")?.getAttribute("title")).toBe(`Link title ${XSS}`);
    const mdImage = container.querySelector("img[alt^='Md alt']") as Element;
    expect(mdImage.getAttribute("alt")).toBe(`Md alt ${XSS}`);
    expect(mdImage.getAttribute("title")).toBe(`Md title ${XSS}`);
    expect(container.querySelector("img[alt^='Image alt']")?.getAttribute("alt")).toBe(`Image alt ${XSS}`);
    expect(container.querySelector("img[alt^='Diagram alt']")?.getAttribute("alt")).toBe(`Diagram alt ${XSS}`);
    // The only elements are the ones the tree asked for: three images, no script.
    expect(find(container, "img")).toHaveLength(3);
  });

  it("shows it literally in the alt text of an image that failed to load", () => {
    const { container } = renderTree(nodes);
    fireEvent.error(container.querySelector("img[alt^='Image alt']") as Element);
    expect(screen.getByText(`Image alt ${XSS}`)).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
  });
});

describe("nodes that cannot be shown", () => {
  it("renders nothing for an unknown node type, warns once naming it, and shows the rest", () => {
    const log = spyOnConsole();
    renderTree([paragraph(text("Before")), { type: "table", children: [] }, paragraph(text("After"))]);

    expect(screen.getByText("Before")).toBeTruthy();
    expect(screen.getByText("After")).toBeTruthy();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0][0])).toContain("table");
    expect(log.error).not.toHaveBeenCalled();
  });

  it("does not log again when the lesson re-renders", () => {
    const log = spyOnConsole();
    const { rerenderTree } = renderTree([{ type: "html", value: "<b>x</b>" }, component("Nope")]);
    rerenderTree();
    rerenderTree();

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("logs once under StrictMode, which runs effects twice", () => {
    const log = spyOnConsole();
    renderTree([{ type: "table", children: [] }, component("Fancy"), component("Image", {})], { strict: true });

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  it("skips a node that is not an object, in a paragraph, without crashing", () => {
    const log = spyOnConsole();
    renderTree([{ type: "paragraph", children: ["raw string", null, 3, text("kept")] }, { type: "list" }]);
    expect(screen.getByText("kept")).toBeTruthy();
    expect(log.warn).toHaveBeenCalled();
  });

  it("renders a box and logs once, naming the component, for an unknown component", () => {
    const log = spyOnConsole();
    renderTree([paragraph(text("Before")), component("Fancy", { a: "b" }), paragraph(text("After"))]);

    expect(screen.getByText("This content can't be shown")).toBeTruthy();
    expect(screen.getByText("After")).toBeTruthy();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(String(log.error.mock.calls[0][0])).toContain("Fancy");
  });

  it.each(["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "Tab", "image", ""])(
    "treats the component name %j as unknown",
    (name) => {
      const log = spyOnConsole();
      renderTree([component(name, { label: "x", alt: "a", src: "/api/x.png" }, [paragraph(text("child"))])]);

      expect(screen.getByText("This content can't be shown")).toBeTruthy();
      expect(screen.queryByText("child")).toBeNull();
      expect(log.error).toHaveBeenCalledTimes(1);
    },
  );

  it("renders a box for a component node without a name or with props that are not an object", () => {
    const log = spyOnConsole();
    renderTree([{ type: "component" }, { type: "component", name: "Image", props: "nope", children: [] }]);
    expect(screen.getAllByText("This content can't be shown")).toHaveLength(2);
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  it("renders a box for a known component with bad props, and logs once naming it", () => {
    const log = spyOnConsole();
    const { rerenderTree } = renderTree([component("Image", { src: "/api/x.png" })]);
    rerenderTree();

    expect(screen.getByText("This content can't be shown")).toBeTruthy();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(String(log.error.mock.calls[0][0])).toContain("Image");
  });

  it.each(["Video", "Model3D", "CodeSteps"])("shows the box for %s until it is built, without an error", (name) => {
    const log = spyOnConsole();
    renderTree([component(name, { src: "/api/x.mp4", title: "t", alt: "a", poster: "/api/p.png", step: "1" })]);
    expect(screen.getByText("This content can't be shown")).toBeTruthy();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("ignores props that are not in the schema", () => {
    const { container } = renderTree([
      component("Image", { src: "/api/x.png", alt: "Fine", onload: "alert(1)", style: "x", unknown: "y" }),
    ]);
    expect(container.querySelector("img")?.getAttribute("alt")).toBe("Fine");
    expect(container.querySelector("img")?.hasAttribute("onload")).toBe(false);
    expect(container.querySelector("img")?.hasAttribute("style")).toBe(false);
  });

  it("renders a deeply nested tree (100 levels) without a stack error", () => {
    let node: unknown = paragraph(text("deepest"));
    for (let i = 0; i < 100; i += 1) node = { type: "blockquote", children: [node] };
    renderTree([node]);
    expect(screen.getByText("deepest")).toBeTruthy();
  });

  it("renders the sample build output with every component and still shows the text around them", () => {
    const log = spyOnConsole();
    const { container } = renderTree(allAssetsNodes);

    expect(container.querySelector("img[alt='A picture']")).toBeTruthy();
    expect(container.querySelector("img[alt='A flow']")).toBeTruthy();
    expect(container.querySelector(".callout-note")).toBeTruthy();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    // Mermaid-only Diagram, Video, Model3D, CodeSteps and a Model3D in a tab: boxes, not crashes.
    expect(screen.getAllByText("This content can't be shown").length).toBeGreaterThanOrEqual(6);
    // Only the Mermaid-only Diagram is a mistake in the lesson.
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
