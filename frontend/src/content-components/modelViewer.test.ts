import { expect, it, vi } from "vitest";
import { loadModelViewer } from "./modelViewer";

const viewer = vi.hoisted(() => ({ factoryRuns: 0, fail: true }));
vi.mock("@google/model-viewer", () => {
  viewer.factoryRuns += 1;
  if (viewer.fail) throw new Error("Failed to fetch dynamically imported module");
  return { loaded: true };
});

it("forgets a failed load, so a later call tries again, and shares one promise after a success", async () => {
  await expect(loadModelViewer()).rejects.toThrow();
  const failedRuns = viewer.factoryRuns;

  viewer.fail = false;
  const first = loadModelViewer();
  const second = loadModelViewer();

  expect(second).toBe(first);
  await expect(first).resolves.toBeTruthy();
  expect(viewer.factoryRuns).toBe(failedRuns + 1);
  expect(loadModelViewer()).toBe(first);
});
