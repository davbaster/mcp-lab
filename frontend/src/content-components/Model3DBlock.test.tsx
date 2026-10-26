import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { stubCores, stubDesktop, stubReducedMotion, stubWebgl, stubWidth } from "../test/device";
import { component, paragraph, renderTree, spyOnConsole, tab, text } from "../test/renderTree";

/**
 * The module of <model-viewer> is a stand-in that counts: the factory runs when the module is first
 * imported (the code of three.js is not loaded in a test). The tests run in one module registry, and
 * the first one proves that nothing was imported before a model needed it.
 */
const viewerModule = vi.hoisted(() => ({ imports: 0 }));
vi.mock("@google/model-viewer", () => {
  viewerModule.imports += 1;
  return {};
});

const SRC = "/api/courses/c/assets/server-eda47e6f1c7979c4.glb";
const POSTER = "/api/courses/c/assets/banner-9523775ba3da5de4.webp";
const model = (props: Record<string, unknown> = {}) => component("Model3D", { src: SRC, alt: "A server", poster: POSTER, ...props });

const viewerIn = (container: HTMLElement) => container.querySelector("model-viewer") as HTMLElement;
const settle = () => new Promise((done) => setTimeout(done, 20));

describe("loading <model-viewer> on demand", () => {
  it("imports nothing for a lesson without a Model3D", async () => {
    stubDesktop();
    renderTree([paragraph(text("Only text.")), component("Callout", { type: "note" }, [paragraph(text("A note."))])]);
    await settle();

    expect(screen.getByText("Only text.")).toBeTruthy();
    expect(viewerModule.imports).toBe(0);
  });

  it("imports nothing for a Model3D that waits for a button, until the button is pressed", async () => {
    stubWebgl();
    stubCores(8);
    stubWidth(360);
    const { user } = renderTree([model()]);
    await settle();
    expect(viewerModule.imports).toBe(0);

    await user.click(screen.getByRole("button", { name: "Load 3D model" }));
    await waitFor(() => expect(viewerModule.imports).toBe(1));
  });

  it("imports it once for two models on the same lesson, and for a model that mounts later", async () => {
    stubDesktop();
    const { rerenderTree } = renderTree([model(), model({ alt: "A box" })]);
    await waitFor(() => expect(screen.queryAllByRole("img")).toHaveLength(0));
    expect(viewerModule.imports).toBe(1);

    rerenderTree([model(), model({ alt: "A box" }), model({ alt: "A third" })]);
    await settle();
    expect(viewerModule.imports).toBe(1);
  });
});

describe("Model3D on a capable device", () => {
  it("renders <model-viewer> with src, alt, poster, camera-controls, lazy loading and touch-action pan-y", () => {
    stubDesktop();
    const { container } = renderTree([model()]);
    const viewer = viewerIn(container);

    expect(viewer.getAttribute("src")).toBe(SRC);
    expect(viewer.getAttribute("alt")).toBe("A server");
    expect(viewer.getAttribute("poster")).toBe(POSTER);
    expect(viewer.hasAttribute("camera-controls")).toBe(true);
    expect(viewer.getAttribute("loading")).toBe("lazy");
    expect(viewer.getAttribute("touch-action")).toBe("pan-y");
    expect(viewer.hasAttribute("auto-rotate")).toBe(false);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the poster as an image with the alt text while the viewer's code loads, then hands over to the viewer", async () => {
    stubDesktop();
    const { container } = renderTree([model()]);
    const poster = screen.getByRole("img", { name: "A server" });
    expect(poster.getAttribute("src")).toBe(POSTER);

    await waitFor(() => expect(container.querySelector("img")).toBeNull());
    expect(viewerIn(container)).toBeTruthy();
  });

  it("puts the viewer in a frame with the media-frame class that content.css gives a 16:9 box", () => {
    stubDesktop();
    const { container } = renderTree([model()]);
    expect(container.querySelector(".model3d > .media-frame > model-viewer")).toBeTruthy();
  });

  it("is not low-end when the browser does not say how many cores it has", () => {
    stubDesktop();
    stubCores(undefined);
    const { container } = renderTree([model()]);
    expect(viewerIn(container)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("treats 3 cores as capable and 480px as wide enough", () => {
    stubDesktop();
    stubCores(3);
    stubWidth(480);
    const { container } = renderTree([model()]);
    expect(viewerIn(container)).toBeTruthy();
  });

  it("shows the poster and a note, and no error is logged, when the viewer reports an error", async () => {
    stubDesktop();
    const log = spyOnConsole();
    const { container } = renderTree([model()]);
    await waitFor(() => expect(container.querySelector("img")).toBeNull());

    act(() => {
      viewerIn(container).dispatchEvent(new CustomEvent("error", { detail: { type: "loadfailure" } }));
    });

    expect(container.querySelector("model-viewer")).toBeNull();
    expect(screen.getByRole("img", { name: "A server" }).getAttribute("src")).toBe(POSTER);
    expect(screen.getByText("This 3D model could not be loaded.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("keeps its model when the window is resized to a narrow width later", async () => {
    stubDesktop();
    const { container } = renderTree([model()]);
    await waitFor(() => expect(container.querySelector("img")).toBeNull());

    stubWidth(320);
    fireEvent(window, new Event("resize"));

    expect(viewerIn(container)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("works for two models, each with its own error state", async () => {
    stubDesktop();
    const { container } = renderTree([model({ alt: "First" }), model({ alt: "Second" })]);
    await waitFor(() => expect(container.querySelector("img")).toBeNull());
    act(() => {
      container.querySelectorAll("model-viewer")[0].dispatchEvent(new CustomEvent("error"));
    });

    expect(container.querySelectorAll("model-viewer")).toHaveLength(1);
    expect(container.querySelector("model-viewer")?.getAttribute("alt")).toBe("Second");
    expect(screen.getAllByText("This 3D model could not be loaded.")).toHaveLength(1);
  });

  it("mounts a model in a hidden tab with lazy loading, so the model file waits until the tab is shown", () => {
    stubDesktop();
    const { container } = renderTree([component("Tabs", {}, [tab("One", paragraph(text("First."))), tab("Two", model())])]);
    const viewer = viewerIn(container);

    expect((viewer.closest("[role='tabpanel']") as HTMLElement).hidden).toBe(true);
    expect(viewer.getAttribute("loading")).toBe("lazy");
  });
});

describe("Model3D on a small or slow device", () => {
  it.each([
    ["a narrow screen", () => stubWidth(479)],
    ["a 360px screen", () => stubWidth(360)],
    ["2 cores", () => stubCores(2)],
    ["1 core", () => stubCores(1)],
    ["0 cores", () => stubCores(0)],
  ])("shows the poster and a button on %s, and loads nothing", async (_name, narrow) => {
    stubDesktop();
    narrow();
    const { container } = renderTree([model()]);
    await settle();

    expect(screen.getByRole("img", { name: "A server" }).getAttribute("src")).toBe(POSTER);
    expect(screen.getByRole("button", { name: "Load 3D model" }).tagName).toBe("BUTTON");
    expect(container.querySelector("model-viewer")).toBeNull();
    expect(screen.queryByText("3D view is not available on this device")).toBeNull();
  });

  it("makes the button a real button of at least 44px (the .button class)", () => {
    stubDesktop();
    stubWidth(360);
    renderTree([model()]);
    const button = screen.getByRole("button", { name: "Load 3D model" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.className).toContain("button");
  });

  it("loads the viewer when the button is pressed, removes the button, and moves focus to the viewer", async () => {
    stubDesktop();
    stubWidth(360);
    const { container, user } = renderTree([model()]);

    await user.click(screen.getByRole("button", { name: "Load 3D model" }));

    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
    const viewer = viewerIn(container);
    expect(viewer.getAttribute("src")).toBe(SRC);
    expect(viewer.getAttribute("alt")).toBe("A server");
    expect(viewer.getAttribute("poster")).toBe(POSTER);
    expect(viewer.hasAttribute("camera-controls")).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(viewer));
  });

  it("moves focus into the viewer's focusable part when the model is shown", async () => {
    stubDesktop();
    stubWidth(360);
    const { container, user } = renderTree([model()]);
    await user.click(screen.getByRole("button", { name: "Load 3D model" }));
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
    // A stand-in for the part of <model-viewer> that is in its shadow DOM and shown with the model.
    const viewer = viewerIn(container);
    const inner = document.createElement("div");
    inner.tabIndex = 0;
    Object.defineProperty(viewer, "shadowRoot", { value: { querySelector: () => inner } });
    document.body.append(inner);
    act(() => {
      viewer.dispatchEvent(new CustomEvent("model-visibility", { detail: { visible: true } }));
    });

    await waitFor(() => expect(document.activeElement).toBe(inner));
    inner.remove();
  });

  it("does not take focus when the model is shown and the learner has moved on", async () => {
    stubDesktop();
    stubWidth(360);
    const { container, user } = renderTree([paragraph(text("x")), model(), component("Callout", { type: "note" }, [paragraph(text("n"))])]);
    await user.click(screen.getByRole("button", { name: "Load 3D model" }));
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    act(() => {
      viewerIn(container).dispatchEvent(new CustomEvent("model-visibility", { detail: { visible: true } }));
    });
    await settle();

    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it("does not move focus for a model that loads by itself", async () => {
    stubDesktop();
    const { container } = renderTree([model()]);
    await waitFor(() => expect(container.querySelector("img")).toBeNull());
    act(() => {
      viewerIn(container).dispatchEvent(new CustomEvent("model-visibility", { detail: { visible: true } }));
    });
    await settle();

    expect(document.activeElement).toBe(document.body);
  });

  it("works from the keyboard", async () => {
    stubDesktop();
    stubCores(2);
    const { container, user } = renderTree([model()]);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Load 3D model" }));
    await user.keyboard("{Enter}");

    await waitFor(() => expect(document.activeElement).toBe(viewerIn(container)));
  });

  it("gives each model its own decision and its own button", async () => {
    stubDesktop();
    stubWidth(360);
    const { container, user } = renderTree([model({ alt: "First" }), model({ alt: "Second" })]);
    expect(screen.getAllByRole("button", { name: "Load 3D model" })).toHaveLength(2);

    await user.click(screen.getAllByRole("button", { name: "Load 3D model" })[1]);

    await waitFor(() => expect(container.querySelector("model-viewer")?.getAttribute("alt")).toBe("Second"));
    expect(container.querySelectorAll("model-viewer")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Load 3D model" })).toHaveLength(1);
    expect(screen.getByRole("img", { name: "First" })).toBeTruthy();
  });

  it("keeps a model that was loaded when the window is resized", async () => {
    stubDesktop();
    stubWidth(360);
    const { container, user } = renderTree([model()]);
    await user.click(screen.getByRole("button", { name: "Load 3D model" }));
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());

    stubWidth(1280);
    fireEvent(window, new Event("resize"));
    expect(viewerIn(container)).toBeTruthy();
  });

  it("shows the poster, the note and no button when the viewer fails after the press", async () => {
    stubDesktop();
    stubWidth(360);
    const { container, user } = renderTree([model()]);
    await user.click(screen.getByRole("button", { name: "Load 3D model" }));
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());

    act(() => {
      viewerIn(container).dispatchEvent(new CustomEvent("error"));
    });

    expect(screen.getByText("This 3D model could not be loaded.")).toBeTruthy();
    expect(screen.getByRole("img", { name: "A server" })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("Model3D without WebGL", () => {
  it.each([
    ["a wide, fast device", () => stubDesktop()],
    ["a narrow screen", () => stubWidth(360)],
    ["few cores", () => stubCores(1)],
  ])("shows only the poster and the note on %s, with no button and no import", async (_name, device) => {
    stubDesktop();
    device();
    const before = viewerModule.imports;
    stubWebgl([]);
    const { container } = renderTree([model()]);
    await settle();

    expect(screen.getByRole("img", { name: "A server" }).getAttribute("src")).toBe(POSTER);
    expect(screen.getByText("3D view is not available on this device")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("model-viewer")).toBeNull();
    expect(viewerModule.imports).toBe(before);
  });

  it("asks for webgl2, then webgl, and gives every test context back", () => {
    stubDesktop();
    const webgl = stubWebgl(["webgl"]);
    renderTree([model()]);

    expect(webgl.asked).toEqual(["webgl2", "webgl"]);
    expect(webgl.created).toBe(1);
    expect(webgl.lost).toBe(1);
  });

  it("uses the first context it can create (webgl2) and gives it back", () => {
    stubDesktop();
    const webgl = stubWebgl(["webgl2", "webgl"]);
    renderTree([model()]);

    expect(webgl.asked).toEqual(["webgl2"]);
    expect(webgl.lost).toBe(1);
  });

  it("checks for WebGL once for a page of many models", () => {
    stubDesktop();
    const webgl = stubWebgl();
    renderTree([model(), model({ alt: "B" }), model({ alt: "C" })]);

    expect(webgl.asked).toEqual(["webgl2"]);
    expect(webgl.created).toBe(1);
  });

  it("is not available when getContext throws", () => {
    stubDesktop();
    const webgl = stubWebgl();
    webgl.spy.mockImplementation(() => {
      throw new Error("blocked");
    });
    renderTree([model()]);
    expect(screen.getByText("3D view is not available on this device")).toBeTruthy();
  });
});

describe("Model3D and reduced motion", () => {
  it("has interaction-prompt none and no auto-rotate with reduced motion", () => {
    stubDesktop();
    stubReducedMotion(true);
    const { container } = renderTree([model()]);

    expect(viewerIn(container).getAttribute("interaction-prompt")).toBe("none");
    expect(viewerIn(container).hasAttribute("auto-rotate")).toBe(false);
  });

  it("keeps the viewer's own hint without the preference", () => {
    stubDesktop();
    const { container } = renderTree([model()]);
    expect(viewerIn(container).hasAttribute("interaction-prompt")).toBe(false);
    expect(viewerIn(container).hasAttribute("auto-rotate")).toBe(false);
  });

  it("follows a change of the preference while the page is open", () => {
    stubDesktop();
    const motion = stubReducedMotion(false);
    const { container } = renderTree([model()]);
    expect(viewerIn(container).hasAttribute("interaction-prompt")).toBe(false);

    act(() => motion.set(true));
    expect(viewerIn(container).getAttribute("interaction-prompt")).toBe("none");
    expect(viewerIn(container).hasAttribute("auto-rotate")).toBe(false);

    act(() => motion.set(false));
    expect(viewerIn(container).hasAttribute("interaction-prompt")).toBe(false);
  });

  it("stops listening when the model is removed", () => {
    stubDesktop();
    const motion = stubReducedMotion(false);
    const { unmount } = renderTree([model()]);
    expect(motion.listeners()).toBe(1);
    unmount();
    expect(motion.listeners()).toBe(0);
  });

  it("works in a browser without matchMedia", () => {
    stubDesktop();
    Reflect.deleteProperty(window, "matchMedia");
    const { container } = renderTree([model()]);
    expect(viewerIn(container).hasAttribute("interaction-prompt")).toBe(false);
  });
});

describe("Model3D props", () => {
  it.each([
    ["no alt", { alt: undefined }, "alt"],
    ["an empty alt", { alt: "" }, "alt"],
    ["a blank alt", { alt: "   " }, "alt"],
    ["alt as a bare attribute", { alt: true }, "alt"],
    ["no poster", { poster: undefined }, "poster"],
    ["an empty poster", { poster: "" }, "poster"],
    ["an external poster", { poster: "https://example.com/p.png" }, "poster"],
    ["a data poster", { poster: "data:image/png;base64,AAAA" }, "poster"],
    ["a relative poster", { poster: "p.png" }, "poster"],
    ["no src", { src: undefined }, "src"],
    ["an empty src", { src: "" }, "src"],
    ["an external src", { src: "https://example.com/a.glb" }, "src"],
    ["a protocol-relative src", { src: "//example.com/a.glb" }, "src"],
    ["a javascript: src", { src: "javascript:alert(1)" }, "src"],
    ["a relative src", { src: "models/a.glb" }, "src"],
  ])("shows the can't-be-shown box and logs once for %s", async (_name, props, prop) => {
    stubDesktop();
    const before = viewerModule.imports;
    const log = spyOnConsole();
    const { container } = renderTree([model(props)]);
    await settle();

    expect(container.querySelector("model-viewer, img, button")).toBeNull();
    expect(screen.getByText("This content can't be shown")).toBeTruthy();
    expect(log.error).toHaveBeenCalledTimes(1);
    const message = String(log.error.mock.calls[0][0]);
    expect(message).toContain("Model3D");
    expect(message).toContain(prop);
    expect(viewerModule.imports).toBe(before);
  });

  it("ignores props that are not in the schema", () => {
    stubDesktop();
    const { container } = renderTree([model({ onload: "alert(1)", style: "x", "auto-rotate": "true", ar: "true" })]);
    for (const attribute of ["onload", "style", "auto-rotate", "ar"]) expect(viewerIn(container).hasAttribute(attribute)).toBe(false);
  });
});
