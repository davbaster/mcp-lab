import { fireEvent, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { component, paragraph, renderTree, spyOnConsole, text } from "../test/renderTree";

const diagram = (props: Record<string, unknown> = {}) =>
  component("Diagram", { src: "/api/courses/c/assets/flow-1.svg", alt: "A flow", ...props });

it("renders the SVG file as an img, and never as inline SVG, object, iframe or embed", () => {
  const { container } = renderTree([diagram()]);
  const img = container.querySelector("img") as HTMLImageElement;

  expect(img.getAttribute("src")).toBe("/api/courses/c/assets/flow-1.svg");
  expect(img.getAttribute("alt")).toBe("A flow");
  expect(img.getAttribute("loading")).toBe("lazy");
  expect(screen.getByRole("img", { name: "A flow" })).toBeTruthy();
  for (const tag of ["svg", "object", "iframe", "embed"]) expect(container.querySelector(tag)).toBeNull();
});

it("has a View full size link to the same file that opens in a new tab", () => {
  renderTree([diagram()]);
  const anchor = screen.getByRole("link", { name: "View full size" });
  expect(anchor.getAttribute("href")).toBe("/api/courses/c/assets/flow-1.svg");
  expect(anchor.getAttribute("target")).toBe("_blank");
  expect(anchor.getAttribute("rel")).toBe("noopener noreferrer");
});

it("shows the alt text in a box, without the link, when the file fails to load", () => {
  const { container } = renderTree([diagram(), paragraph(text("After"))]);
  fireEvent.error(container.querySelector("img") as Element);

  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByText("A flow").className).toContain("media-fallback");
  expect(screen.queryByRole("link", { name: "View full size" })).toBeNull();
  expect(screen.getByText("After")).toBeTruthy();
});

it("shows the box for a Diagram that has source and no src, and logs once", () => {
  const log = spyOnConsole();
  const { container } = renderTree([component("Diagram", { alt: "Message flow", source: "graph TD; A-->B" })]);

  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByText("This content can't be shown")).toBeTruthy();
  expect(screen.queryByText("graph TD; A-->B")).toBeNull();
  expect(log.error).toHaveBeenCalledTimes(1);
  expect(String(log.error.mock.calls[0][0])).toContain("Diagram");
});

it.each([
  ["no alt", { alt: undefined }],
  ["an empty alt", { alt: "" }],
  ["an external src", { src: "https://example.com/a.svg" }],
  ["a data src", { src: "data:image/svg+xml;base64,AAAA" }],
  ["a protocol-relative src", { src: "//example.com/a.svg" }],
  ["a relative src", { src: "diagrams/flow.svg" }],
])("shows the box for %s", (_name, props) => {
  spyOnConsole();
  const { container } = renderTree([diagram(props)]);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("a")).toBeNull();
  expect(screen.getByText("This content can't be shown")).toBeTruthy();
});
