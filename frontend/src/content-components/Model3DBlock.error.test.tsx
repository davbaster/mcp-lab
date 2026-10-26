import { screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { stubDesktop, stubWidth } from "../test/device";
import { component, renderTree, spyOnConsole } from "../test/renderTree";

// The code of <model-viewer> cannot be loaded: the import rejects.
vi.mock("@google/model-viewer", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

const model = (props: Record<string, unknown> = {}) =>
  component("Model3D", { src: "/api/courses/c/assets/a.glb", alt: "A server", poster: "/api/courses/c/assets/p.png", ...props });

it("keeps the poster, shows the note and no button when the code cannot be loaded", async () => {
  stubDesktop();
  const log = spyOnConsole();
  const { container } = renderTree([model()]);

  expect(await screen.findByText("This 3D model could not be loaded.")).toBeTruthy();
  expect(screen.getByRole("img", { name: "A server" }).getAttribute("src")).toBe("/api/courses/c/assets/p.png");
  expect(screen.queryByRole("button")).toBeNull();
  expect(container.querySelector("model-viewer")).toBeNull();
  // The author did not make a mistake, so nothing is logged as an error.
  expect(log.error).not.toHaveBeenCalled();
});

it("shows the same note after the button is pressed", async () => {
  stubDesktop();
  stubWidth(360);
  const { user } = renderTree([model()]);

  await user.click(screen.getByRole("button", { name: "Load 3D model" }));

  expect(await screen.findByText("This 3D model could not be loaded.")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
  expect(screen.getByRole("img", { name: "A server" })).toBeTruthy();
});
