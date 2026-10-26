import { afterEach, expect, it, vi } from "vitest";
import { consoleErrors, uninstallConsoleBuffer } from "./consoleBuffer";

// A render that logs an error, as a failing component would.
vi.mock("react-dom/client", () => ({
  createRoot: () => ({
    render: () => {
      console.error("error during the first render");
    },
  }),
}));

afterEach(() => {
  uninstallConsoleBuffer();
  document.body.innerHTML = "";
});

it("installs the console buffer in main.tsx, before the first render", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const original = vi.spyOn(console, "error").mockImplementation(() => {});

  await import("../main");

  expect(consoleErrors()).toEqual(["error during the first render"]);
  expect(original).toHaveBeenCalledTimes(1);
});
