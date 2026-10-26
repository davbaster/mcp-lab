/**
 * Renders a lesson tree the way the lesson page does, inside a router (links need one), and
 * builds tree nodes for tests. Spy on `console.warn` and `console.error` with `spyOnConsole`.
 */
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, vi } from "vitest";
import { LessonContent } from "../content-components/LessonContent";
import type { LessonTree } from "../content-components/tree";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

export const text = (value: string) => ({ type: "text", value });
export const paragraph = (...children: unknown[]) => ({ type: "paragraph", children });
export const heading = (depth: number, value: string) => ({ type: "heading", depth, children: [text(value)] });
export const link = (url: unknown, label: string, title?: string) => ({
  type: "link",
  url,
  ...(title !== undefined && { title }),
  children: [text(label)],
});
export const component = (name: string, props: Record<string, unknown> = {}, children: unknown[] = []) => ({
  type: "component",
  name,
  props,
  children,
});
export const tab = (label: string, ...children: unknown[]) => component("Tab", { label }, children);

export function spyOnConsole() {
  return {
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

export function renderTree(children: unknown[], options: { title?: string; strict?: boolean } = {}) {
  const user = userEvent.setup();
  const title = options.title ?? "Lesson title";
  const element = (nodes: unknown[]) => (
    <MemoryRouter>
      <LessonContent tree={{ type: "root", children: nodes } as LessonTree} title={title} />
    </MemoryRouter>
  );
  const view = render(options.strict ? <StrictMode>{element(children)}</StrictMode> : element(children));
  return { ...view, user, rerenderTree: (nodes: unknown[] = children) => view.rerender(options.strict ? <StrictMode>{element(nodes)}</StrictMode> : element(nodes)) };
}
