import { fireEvent, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { component, paragraph, renderTree, spyOnConsole, text } from "../test/renderTree";

const image = (props: Record<string, unknown> = {}) =>
  component("Image", { src: "/api/courses/c/assets/pic-1.png", alt: "A picture", ...props });

it("renders an img with the src, the alt and lazy loading", () => {
  const { container } = renderTree([image()]);
  const img = container.querySelector("img") as HTMLImageElement;
  expect(img.getAttribute("src")).toBe("/api/courses/c/assets/pic-1.png");
  expect(img.getAttribute("alt")).toBe("A picture");
  expect(img.getAttribute("loading")).toBe("lazy");
  expect(screen.getByRole("img", { name: "A picture" })).toBeTruthy();
});

it("replaces the image with a box that shows the alt text when the file fails to load", () => {
  const { container } = renderTree([image(), paragraph(text("After"))]);
  fireEvent.error(container.querySelector("img") as Element);

  expect(container.querySelector("img")).toBeNull();
  const box = screen.getByText("A picture");
  expect(box.className).toContain("media-fallback");
  expect(screen.getByText("After")).toBeTruthy();
});

it.each([
  ["no alt", { alt: undefined }],
  ["an empty alt", { alt: "" }],
  ["a blank alt", { alt: "   " }],
  ["alt as a bare attribute", { alt: true }],
  ["no src", { src: undefined }],
  ["an empty src", { src: "" }],
  ["an external src", { src: "https://example.com/a.png" }],
  ["a data src", { src: "data:image/png;base64,AAAA" }],
  ["a protocol-relative src", { src: "//example.com/a.png" }],
  ["a relative src", { src: "images/pic.png" }],
])("shows the can't-be-shown box for %s", (_name, props) => {
  const log = spyOnConsole();
  const { container } = renderTree([image(props)]);
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByText("This content can't be shown")).toBeTruthy();
  expect(log.error).toHaveBeenCalledTimes(1);
  expect(String(log.error.mock.calls[0][0])).toContain("Image");
});
