import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Link, Route, Routes } from "react-router";
import { expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthProvider";
import { apiRoutes } from "../test/apiRoutes";
import { jsonResponse } from "../test/mockApi";
import { renderApp } from "../test/renderApp";
import { Layout } from "./Layout";
import { PageHeading } from "./PageHeading";

const pages = ["/", "/login", "/register", "/courses/x", "/courses/x/lessons/y", "/courses/x/chapters/c/quiz", "/nope"];

it.each(pages)("makes the skip link the first Tab stop at %s", async (url) => {
  apiRoutes();
  const { user } = renderApp(url);

  await user.tab();

  expect(document.activeElement).toBe(screen.getByRole("link", { name: "Skip to main content" }));
});

it.each(pages)("has the Send feedback button in the header at %s, for a visitor", async (url) => {
  apiRoutes();
  renderApp(url);

  const button = within(screen.getByRole("banner")).getByRole("button", { name: "Send feedback" });
  expect(button.className).toBe("button button-secondary");
  expect(screen.getAllByRole("button", { name: "Send feedback" })).toHaveLength(1);
  await within(screen.getByRole("navigation", { name: "Account" })).findByRole("link", { name: "Sign in" });
});

it.each(pages)("has the Send feedback button in the header at %s, for a learner", async (url) => {
  apiRoutes({ "GET /api/auth/me": () => jsonResponse({ username: "ada_l" }) });
  renderApp(url);

  await screen.findByText("ada_l");
  expect(within(screen.getByRole("banner")).getByRole("button", { name: "Send feedback" })).toBeTruthy();
});

it("puts the Send feedback button after the account controls of a learner", async () => {
  apiRoutes({ "GET /api/auth/me": () => jsonResponse({ username: "ada_l" }) });
  const { user } = renderApp("/nope");
  await screen.findByText("ada_l");

  await user.tab();
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("link", { name: "Courses" }));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Sign out" }));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Send feedback" }));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("link", { name: "Back to all courses" }));
});

it("moves focus to main when the skip link is used", async () => {
  apiRoutes();
  const { user } = renderApp("/");

  await user.tab();
  await user.keyboard("{Enter}");

  expect(document.activeElement).toBe(screen.getByRole("main"));
});

it("does not put a hash in the URL when the skip link is used", async () => {
  apiRoutes();
  const { user, currentUrl } = renderApp("/login");

  await user.click(screen.getByRole("link", { name: "Skip to main content" }));

  expect(currentUrl()).toBe("/login");
});

it("tabs from the skip link to the app name, the header controls, the feedback button, and then the page", async () => {
  apiRoutes();
  const { user } = renderApp("/nope");
  await within(screen.getByRole("navigation", { name: "Account" })).findByRole("link", { name: "Sign in" });

  await user.tab();
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("link", { name: "Courses" }));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("link", { name: "Sign in" }));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("link", { name: "Create account" }));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Send feedback" }));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("link", { name: "Back to all courses" }));
});

it("has a header with the app name linking to the course list, and a main", () => {
  apiRoutes();
  renderApp("/nope");

  const header = screen.getByRole("banner");
  expect(within(header).getByRole("link", { name: "Courses" }).getAttribute("href")).toBe("/");
  expect(within(screen.getByRole("main")).getByRole("heading", { level: 1 })).toBeTruthy();
});

it("moves focus to the new h1 and scrolls to the top when the path changes", async () => {
  apiRoutes();
  const { user, scrollTo } = renderApp("/");
  await screen.findByText("No courses available yet.");

  await user.click(await screen.findByRole("link", { name: "Create account" }));

  expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Create account" }));
  expect(scrollTo).toHaveBeenCalledWith(0, 0);
});

it("leaves focus and scroll alone on first load", async () => {
  apiRoutes();
  const { scrollTo } = renderApp("/login");
  await screen.findByLabelText("Username");

  expect(document.activeElement).toBe(document.body);
  expect(scrollTo).not.toHaveBeenCalled();
});

it("leaves focus and scroll alone when only the query or hash changes", async () => {
  apiRoutes();
  const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={["/page"]}>
      <AuthProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route
              path="page"
              element={
                <>
                  <PageHeading>Page</PageHeading>
                  <Link to="?tab=2">Query</Link>
                  <Link to="#part">Hash</Link>
                </>
              }
            />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );

  await user.click(screen.getByRole("link", { name: "Query" }));
  await user.click(screen.getByRole("link", { name: "Hash" }));

  expect(scrollTo).not.toHaveBeenCalled();
  expect(document.activeElement).not.toBe(screen.getByRole("heading", { level: 1 }));
});

it("leaves focus and scroll alone on a reload of an entry that still carries the sign-out flag", async () => {
  apiRoutes();
  const { scrollTo } = renderApp({ pathname: "/", state: { focusHeading: true } });
  await screen.findByText("No courses available yet.");

  expect(scrollTo).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(document.body);
});
