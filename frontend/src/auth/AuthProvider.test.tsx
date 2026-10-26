import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { api } from "../api/client";
import { NETWORK_ERROR_MESSAGE, UNEXPECTED_RESPONSE_MESSAGE } from "../api/apiError";
import { apiRoutes, deferred } from "../test/apiRoutes";
import { errorResponse, htmlResponse, jsonResponse } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

const learner = () => jsonResponse({ username: "ada_l" });

function account() {
  return screen.getByRole("navigation", { name: "Account" });
}

/** Lets the stubbed network and the middleware finish what they started. */
const settle = () => act(() => new Promise((done) => setTimeout(done, 20)));

it("asks /api/auth/me once on start", async () => {
  const api = apiRoutes({ "GET /api/auth/me": learner });
  renderApp("/");

  await within(account()).findByText("ada_l");

  expect(api.calls("GET /api/auth/me")).toHaveLength(1);
});

it("asks /api/auth/me once on start under StrictMode", async () => {
  const api = apiRoutes({ "GET /api/auth/me": learner });
  renderApp("/", { strict: true });

  await within(account()).findByText("ada_l");

  expect(api.calls("GET /api/auth/me")).toHaveLength(1);
});

it("makes a 200 from /me a signed-in learner", async () => {
  apiRoutes({ "GET /api/auth/me": learner });
  renderApp("/");

  expect(await within(account()).findByText("ada_l")).toBeTruthy();
});

it("makes a 401 from /me a visitor without any message", async () => {
  apiRoutes();
  renderApp("/");

  await within(account()).findByRole("link", { name: "Sign in" });
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each([
  ["a 500", () => errorResponse(500, "internal_error", "Server broke."), "Server broke."],
  ["a network error", () => Promise.reject(new TypeError("Failed to fetch")), NETWORK_ERROR_MESSAGE],
  ["an HTML 502", () => htmlResponse(502), UNEXPECTED_RESPONSE_MESSAGE],
])("runs as a visitor and shows a banner when /me fails with %s", async (_name, answer, message) => {
  apiRoutes({ "GET /api/auth/me": answer });
  renderApp("/");

  const banner = await screen.findByRole("alert");
  expect(within(banner).getByText(message)).toBeTruthy();
  expect(within(banner).getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(within(banner).getByRole("button", { name: "Dismiss" })).toBeTruthy();
  expect(within(account()).getByRole("link", { name: "Sign in" })).toBeTruthy();
  expect(screen.getByRole("main").firstElementChild).toBe(banner);
});

it("repeats /me when Try again is pressed, and a success removes the banner and shows the learner", async () => {
  let attempt = 0;
  const api = apiRoutes({
    "GET /api/auth/me": () => {
      attempt += 1;
      return attempt === 1 ? errorResponse(500, "internal_error", "Server broke.") : learner();
    },
  });
  const { user } = renderApp("/");

  await user.click(await screen.findByRole("button", { name: "Try again" }));

  expect(await within(account()).findByText("ada_l")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(api.calls("GET /api/auth/me")).toHaveLength(2);
  expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
});

it("keeps the banner when Try again fails again", async () => {
  apiRoutes({ "GET /api/auth/me": () => errorResponse(500, "internal_error", "Still broken.") });
  const { user } = renderApp("/");

  await user.click(await screen.findByRole("button", { name: "Try again" }));

  expect(await screen.findByText("Still broken.")).toBeTruthy();
  expect(within(account()).getByRole("link", { name: "Sign in" })).toBeTruthy();
});

it("removes the banner and moves focus to the h1 when it is dismissed", async () => {
  apiRoutes({ "GET /api/auth/me": () => errorResponse(500, "internal_error", "Server broke.") });
  const { user } = renderApp("/login");

  await user.click(await screen.findByRole("button", { name: "Dismiss" }));

  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Sign in" }));
});

it("turns the app into a visitor when another call answers 401 not_authenticated", async () => {
  apiRoutes({
    "GET /api/auth/me": learner,
    "GET /api/courses": () => errorResponse(401, "not_authenticated", "Your session ended."),
  });
  renderApp("/");

  expect(await within(account()).findByRole("link", { name: "Sign in" })).toBeTruthy();
  expect(within(account()).queryByText("ada_l")).toBeNull();
});

it("lets the page read the body of the 401 the middleware looked at", async () => {
  apiRoutes({
    "GET /api/auth/me": learner,
    "GET /api/courses": () => errorResponse(401, "not_authenticated", "Your session ended."),
  });
  renderApp("/");

  const alert = await screen.findByText("Your session ended.");
  expect(alert).toBeTruthy();
});

it("stays signed in when a 401 has another code", async () => {
  apiRoutes({
    "GET /api/auth/me": learner,
    "GET /api/courses": () => errorResponse(401, "invalid_credentials", "Wrong login."),
  });
  renderApp("/");

  await screen.findByText("Wrong login.");
  await settle();
  expect(within(account()).getByText("ada_l")).toBeTruthy();
});

it("stays signed in when a 401 has a body that is not JSON", async () => {
  apiRoutes({
    "GET /api/auth/me": learner,
    "GET /api/courses": () => htmlResponse(401, "<html><body>Unauthorized</body></html>"),
  });
  renderApp("/");

  await screen.findByRole("alert");
  await settle();
  expect(within(account()).getByText("ada_l")).toBeTruthy();
});

it("ignores a 401 not_authenticated for a request that started before the learner signed in", async () => {
  const slowCourses = deferred<Response>();
  let requests = 0;
  apiRoutes({
    // Only the first request is held back; the page asks again after the redirect.
    "GET /api/courses": () => {
      requests += 1;
      return requests === 1 ? slowCourses.promise : jsonResponse({ courses: [] });
    },
    "POST /api/auth/login": () => learner(),
  });
  // /me has answered (401) before the held request starts, so only sign-in can make it stale.
  const { user } = renderApp("/login");
  await screen.findByLabelText("Username");
  await user.click(within(screen.getByRole("banner")).getByRole("link", { name: "Courses" }));
  await screen.findByRole("region", { name: "Course list" });
  expect(requests).toBe(1);
  await user.click(within(account()).getByRole("link", { name: "Sign in" }));
  await user.type(await screen.findByLabelText("Username"), "ada_l");
  await user.type(screen.getByLabelText("Password"), "secret-pass");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  await within(account()).findByText("ada_l");

  await act(async () => {
    slowCourses.resolve(errorResponse(401, "not_authenticated", "Sign in to continue."));
  });
  await settle();

  expect(within(account()).getByText("ada_l")).toBeTruthy();
});

it("removes its middleware from the shared client when the provider unmounts", async () => {
  apiRoutes({ "GET /api/courses": () => errorResponse(401, "not_authenticated", "Sign in to continue.") });
  const { unmount } = renderApp("/");
  await within(account()).findByRole("link", { name: "Sign in" });
  unmount();
  // A leftover middleware would look inside the 401 through a clone of the response.
  const clone = vi.spyOn(Response.prototype, "clone");

  await api.GET("/api/courses");

  expect(clone).not.toHaveBeenCalled();
});

it.each([
  ["another code", () => errorResponse(401, "invalid_credentials", "Wrong login.")],
  ["an HTML body", () => htmlResponse(401, "<html><body>Unauthorized</body></html>")],
])("makes a 401 from /me with %s a visitor without any message", async (_name, answer) => {
  apiRoutes({ "GET /api/auth/me": answer });
  renderApp("/");

  await within(account()).findByRole("link", { name: "Sign in" });
  expect(screen.queryByRole("alert")).toBeNull();
});

it("writes nothing to storage or cookies through a register, sign in and sign out", async () => {
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  const cookie = vi.spyOn(Document.prototype, "cookie", "set");
  apiRoutes({
    "POST /api/auth/register": () => jsonResponse({ username: "ada_l" }, 201),
    "POST /api/auth/login": () => learner(),
    "POST /api/auth/logout": () => new Response(null, { status: 204 }),
  });
  const { user } = renderApp("/register");

  await user.type(await screen.findByLabelText("Username"), "ada_l");
  await user.type(screen.getByLabelText("Password"), "secret-pass");
  await user.click(screen.getByRole("button", { name: "Create account" }));
  await user.click(await within(account()).findByRole("button", { name: "Sign out" }));
  await within(account()).findByRole("link", { name: "Sign in" });
  await user.click(within(account()).getByRole("link", { name: "Sign in" }));
  await user.type(await screen.findByLabelText("Username"), "ada_l");
  await user.type(screen.getByLabelText("Password"), "secret-pass");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  await within(account()).findByText("ada_l");

  expect(setItem).not.toHaveBeenCalled();
  expect(cookie).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
  await waitFor(() => expect(document.cookie).toBe(""));
});
