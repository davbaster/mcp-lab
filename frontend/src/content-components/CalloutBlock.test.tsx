import { screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { component, heading, paragraph, renderTree, spyOnConsole, text } from "../test/renderTree";

it.each([
  ["tip", "Tip"],
  ["warning", "Warning"],
  ["note", "Note"],
] as const)("renders a %s with the visible label %s first", (type, label) => {
  const { container } = renderTree([component("Callout", { type }, [paragraph(text("Body text"))])]);
  const callout = container.querySelector(`.callout-${type}`) as HTMLElement;

  expect(callout).toBeTruthy();
  expect(callout.getAttribute("role")).toBe("note");
  expect(callout.firstElementChild?.textContent).toBe(label);
  expect(within(callout).getByText(label).className).toBe("callout-label");
  expect(within(callout).getByText("Body text")).toBeTruthy();
});

it("shows the title after the label, as plain text and not as a heading", () => {
  const { container } = renderTree([
    heading(2, "Part"),
    component("Callout", { type: "warning", title: "Be careful" }, [paragraph(text("Body"))]),
    heading(3, "Next part"),
  ]);
  const heading_ = container.querySelector(".callout-heading") as HTMLElement;

  expect(heading_.tagName).toBe("P");
  expect(heading_.textContent).toBe("Warning Be careful");
  expect(heading_.querySelector(".callout-title")?.textContent).toBe(" Be careful");
  // The callout adds no heading, so the order stays h2, h3.
  expect(screen.getAllByRole("heading").map((h) => h.tagName)).toEqual(["H2", "H3"]);
});

it("renders a nested image, list and block quote, and a nested callout", () => {
  const { container } = renderTree([
    component("Callout", { type: "note", title: "Nested" }, [
      paragraph({ type: "image", url: "/api/a.png", alt: "Inside" }),
      { type: "list", ordered: false, children: [{ type: "listItem", children: [paragraph(text("Item"))] }] },
      { type: "blockquote", children: [paragraph(text("Quote"))] },
      component("Image", { src: "/api/b.png", alt: "Component image" }),
      component("Callout", { type: "tip" }, [paragraph(text("Inner"))]),
    ]),
  ]);
  const outer = container.querySelector(".callout-note") as HTMLElement;

  expect(within(outer).getByRole("img", { name: "Inside" })).toBeTruthy();
  expect(within(outer).getByRole("img", { name: "Component image" })).toBeTruthy();
  expect(within(outer).getByRole("listitem").textContent).toBe("Item");
  expect(outer.querySelector("blockquote")?.textContent).toBe("Quote");
  expect(outer.querySelector(".callout-tip")?.textContent).toContain("Inner");
});

it("shows the box, not a default variant, for type danger", () => {
  const log = spyOnConsole();
  const { container } = renderTree([component("Callout", { type: "danger" }, [paragraph(text("Hidden"))])]);

  expect(container.querySelector(".callout")).toBeNull();
  expect(screen.getByText("This content can't be shown")).toBeTruthy();
  expect(screen.queryByText("Hidden")).toBeNull();
  expect(log.error).toHaveBeenCalledTimes(1);
  expect(String(log.error.mock.calls[0][0])).toContain("Callout");
});

it.each([
  ["no type", {}],
  ["type true", { type: true }],
  ["an inherited type name", { type: "constructor" }],
  ["an upper-case type", { type: "Tip" }],
  ["an empty title", { type: "tip", title: "" }],
  ["a bare title", { type: "tip", title: true }],
])("shows the box for %s", (_name, props) => {
  spyOnConsole();
  const { container } = renderTree([component("Callout", props)]);
  expect(container.querySelector(".callout")).toBeNull();
  expect(screen.getByText("This content can't be shown")).toBeTruthy();
});

it("ignores a prop that is not in the schema", () => {
  const { container } = renderTree([component("Callout", { type: "tip", color: "red" })]);
  expect(container.querySelector(".callout-tip")).toBeTruthy();
});
