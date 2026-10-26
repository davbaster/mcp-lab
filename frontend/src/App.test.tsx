import { screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { apiRoutes } from "./test/apiRoutes";
import { renderApp } from "./test/renderApp";

it("shows a level 1 heading named Courses", async () => {
  apiRoutes();
  renderApp("/");

  expect(screen.getByRole("heading", { level: 1, name: "Courses" })).toBeTruthy();
  expect(await screen.findByText("No courses available yet.")).toBeTruthy();
});

const routes: [string, string, string][] = [
  ["/", "Courses", "/"],
  ["/courses/mcp", "Course dashboard", "dashboard"],
  ["/courses/mcp/lessons/intro", "Lesson", "lesson"],
  ["/courses/mcp/chapters/ch1/quiz", "Quiz", "quiz"],
  ["/register", "Create account", "register"],
  ["/login", "Sign in", "login"],
];

it.each(routes)("renders %s with the h1 %s (%s)", async (url, heading) => {
  apiRoutes();
  renderApp(url);

  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(screen.getByRole("heading", { level: 1, name: heading })).toBeTruthy();
  // Inside the layout: the header's account links appear once /me has answered.
  const account = screen.getByRole("navigation", { name: "Account" });
  expect(await within(account).findByRole("link", { name: "Sign in" })).toBeTruthy();
});

it.each(["/nope", "/courses", "/courses/a/b/c"])("shows Page not found at %s inside the layout", async (url) => {
  apiRoutes();
  renderApp(url);

  expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeTruthy();
  const back = screen.getByRole("link", { name: "Back to all courses" });
  expect(back.getAttribute("href")).toBe("/");
  expect(screen.getByRole("banner")).toBeTruthy();
  const account = screen.getByRole("navigation", { name: "Account" });
  expect(await within(account).findByRole("link", { name: "Create account" })).toBeTruthy();
});

it("still shows the sign-in page for /login/ with a trailing slash", async () => {
  apiRoutes();
  renderApp("/login/");

  expect(screen.getByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
  expect(await screen.findByLabelText("Username")).toBeTruthy();
});

const titles: [string, string][] = [
  ["/", "Courses"],
  ["/register", "Create account – Courses"],
  ["/login", "Sign in – Courses"],
  ["/nope", "Page not found – Courses"],
  ["/courses/mcp", "Course – Courses"],
  ["/courses/mcp/lessons/intro", "Lesson – Courses"],
  ["/courses/mcp/chapters/ch1/quiz", "Quiz – Courses"],
];

it.each(titles)("sets the document title at %s to %s", async (url, title) => {
  apiRoutes();
  renderApp(url);

  expect(document.title).toBe(title);
  await screen.findByRole("navigation", { name: "Account" });
});

it("changes the document title when the route changes", async () => {
  apiRoutes();
  const { user } = renderApp("/");
  await screen.findByText("No courses available yet.");
  expect(document.title).toBe("Courses");

  const account = screen.getByRole("navigation", { name: "Account" });
  await user.click(await within(account).findByRole("link", { name: "Create account" }));

  expect(document.title).toBe("Create account – Courses");
});
