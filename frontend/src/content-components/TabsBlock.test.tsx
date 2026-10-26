import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { component, paragraph, renderTree, spyOnConsole, tab, text } from "../test/renderTree";

const body = (value: string) => paragraph(text(value));

function threeTabs(prefix = "") {
  return component("Tabs", {}, [
    tab(`${prefix}macOS`, body(`${prefix}mac body`)),
    tab(`${prefix}Windows`, body(`${prefix}win body`)),
    tab(`${prefix}Linux`, body(`${prefix}linux body`)),
  ]);
}

const selectedTab = () => screen.getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true");

describe("roles and state", () => {
  it("has a tablist, tabs and one visible tabpanel, with the first tab selected", () => {
    renderTree([threeTabs()]);

    expect(screen.getByRole("tablist")).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["macOS", "Windows", "Linux"]);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    // Hidden panels are not in the accessibility tree.
    const panels = screen.getAllByRole("tabpanel");
    expect(panels).toHaveLength(1);
    expect(panels[0].textContent).toBe("mac body");
  });

  it("keeps the other panels in the page, hidden", () => {
    const { container } = renderTree([threeTabs()]);
    const panels = Array.from(container.querySelectorAll<HTMLElement>("[role=tabpanel]"));
    expect(panels.map((p) => p.hidden)).toEqual([false, true, true]);
  });

  it("links each tab to its panel and each panel to its tab", () => {
    const { container } = renderTree([threeTabs()]);
    const tabs = screen.getAllByRole("tab");
    const panels = Array.from(container.querySelectorAll("[role=tabpanel]"));
    tabs.forEach((t, i) => {
      expect(t.getAttribute("aria-controls")).toBe(panels[i].id);
      expect(panels[i].getAttribute("aria-labelledby")).toBe(t.id);
    });
  });

  it("puts only the selected tab in the Tab key order, and makes the panel focusable", () => {
    const { container } = renderTree([threeTabs()]);
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    expect(container.querySelector("[role=tabpanel]:not([hidden])")?.getAttribute("tabindex")).toBe("0");
    for (const t of screen.getAllByRole("tab")) expect(t.getAttribute("type")).toBe("button");
  });

  it("moves from the selected tab into the selected panel with the Tab key", async () => {
    const { user } = renderTree([threeTabs()]);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "macOS" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("tabpanel"));
  });
});

describe("selecting", () => {
  it("selects a tab when it is clicked and shows only its panel", async () => {
    const { user } = renderTree([threeTabs()]);
    await user.click(screen.getByRole("tab", { name: "Windows" }));

    expect(selectedTab()?.textContent).toBe("Windows");
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(screen.getByRole("tabpanel").textContent).toBe("win body");
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
  });

  it("moves selection and focus with Right and Left Arrow, wrapping around", async () => {
    const { user } = renderTree([threeTabs()]);
    await user.tab();

    await user.keyboard("{ArrowRight}");
    expect(selectedTab()?.textContent).toBe("Windows");
    expect(document.activeElement).toBe(selectedTab());
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(selectedTab()?.textContent).toBe("macOS");
    expect(document.activeElement).toBe(selectedTab());
    await user.keyboard("{ArrowLeft}");
    expect(selectedTab()?.textContent).toBe("Linux");
    await user.keyboard("{ArrowLeft}");
    expect(selectedTab()?.textContent).toBe("Windows");
    expect(screen.getByRole("tabpanel").textContent).toBe("win body");
  });

  it("goes to the first and last tab with Home and End", async () => {
    const { user } = renderTree([threeTabs()]);
    await user.tab();

    await user.keyboard("{End}");
    expect(selectedTab()?.textContent).toBe("Linux");
    expect(document.activeElement).toBe(selectedTab());
    await user.keyboard("{Home}");
    expect(selectedTab()?.textContent).toBe("macOS");
    expect(document.activeElement).toBe(selectedTab());
  });

  it("does nothing on Up and Down Arrow", async () => {
    const { user } = renderTree([threeTabs()]);
    await user.click(screen.getByRole("tab", { name: "Windows" }));

    await user.keyboard("{ArrowUp}{ArrowDown}");
    expect(selectedTab()?.textContent).toBe("Windows");
    expect(document.activeElement).toBe(selectedTab());
  });
});

describe("more than one Tabs", () => {
  it("keeps ids unique and each Tabs on its own, even with the same labels", async () => {
    const { container, user } = renderTree([threeTabs(), threeTabs()]);

    const ids = Array.from(container.querySelectorAll("[id]")).map((e) => e.id);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);

    const lists = screen.getAllByRole("tablist");
    await user.click(within(lists[1]).getByRole("tab", { name: "Linux" }));
    const selected = screen.getAllByRole("tab").filter((t) => t.getAttribute("aria-selected") === "true");
    expect(selected.map((t) => t.textContent)).toEqual(["macOS", "Linux"]);
    // The first Tabs still points at its own panel.
    const first = within(lists[0]).getByRole("tab", { name: "macOS" });
    expect(document.getElementById(first.getAttribute("aria-controls") as string)?.hidden).toBe(false);
  });

  it("works with a Tabs and a Callout inside a Tab", async () => {
    const { user } = renderTree([
      component("Tabs", {}, [
        tab("Outer one", component("Callout", { type: "tip" }, [body("In callout")]), threeTabs("Inner ")),
        tab("Outer two", body("Second")),
      ]),
    ]);
    const outer = screen.getAllByRole("tablist")[0];

    expect(screen.getByText("In callout")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Inner Linux" }));
    expect(screen.getByText("Inner linux body")).toBeTruthy();
    expect(within(outer).getByRole("tab", { name: "Outer one", selected: true })).toBeTruthy();

    await user.click(within(outer).getByRole("tab", { name: "Outer two" }));
    expect(screen.getByText("Second")).toBeTruthy();
    // The first panel stays in the page, hidden.
    expect(screen.getByText("In callout").closest("[role=tabpanel]")?.hasAttribute("hidden")).toBe(true);
  });

  it("does not let the arrow keys of an inner tab list move the outer one", async () => {
    const { user } = renderTree([
      component("Tabs", {}, [tab("Outer one", threeTabs("Inner ")), tab("Outer two", body("Second"))]),
    ]);
    await user.click(screen.getByRole("tab", { name: "Inner macOS" }));
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("tab", { name: "Inner Windows", selected: true })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Outer one", selected: true })).toBeTruthy();
  });
});

describe("tabs that are missing", () => {
  it("renders the one tab it has when there are fewer than two", () => {
    renderTree([component("Tabs", {}, [tab("Only", body("Only body"))])]);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByRole("tabpanel").textContent).toBe("Only body");
  });

  it("renders the box and logs once, naming Tabs, when there is no Tab", () => {
    const log = spyOnConsole();
    const { container } = renderTree([component("Tabs", {}, [])]);

    expect(container.querySelector("[role=tablist]")).toBeNull();
    expect(screen.getByText("This content can't be shown")).toBeTruthy();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(String(log.error.mock.calls[0][0])).toContain("Tabs");
  });

  it("skips a Tab without a label, and anything else inside Tabs, and logs once", () => {
    const log = spyOnConsole();
    renderTree([
      component("Tabs", {}, [
        tab("Good", body("Good body")),
        component("Tab", {}, [body("No label")]),
        body("Stray paragraph"),
        component("Callout", { type: "tip" }),
      ]),
    ]);

    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Good"]);
    expect(screen.queryByText("Stray paragraph")).toBeNull();
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("logs a bad component in a hidden tab once, and not again when tabs are switched", async () => {
    const log = spyOnConsole();
    const { user } = renderTree([
      component("Tabs", {}, [tab("One", body("One")), tab("Two", component("Fancy"))]),
    ]);
    expect(log.error).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("tab", { name: "Two" }));
    await user.click(screen.getByRole("tab", { name: "One" }));
    await user.click(screen.getByRole("tab", { name: "Two" }));
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
