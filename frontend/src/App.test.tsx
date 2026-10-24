import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import App from "./App";

afterEach(cleanup);

it("shows a level 1 heading named Courses", () => {
  render(<App />);

  expect(screen.getByRole("heading", { level: 1, name: "Courses" })).toBeTruthy();
});
