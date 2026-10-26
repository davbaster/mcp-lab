import { screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { NETWORK_ERROR_MESSAGE, UNEXPECTED_RESPONSE_MESSAGE } from "../api/apiError";
import { apiRoutes, deferred } from "../test/apiRoutes";
import { errorResponse, htmlResponse, jsonResponse } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

const learner = () => jsonResponse({ username: "ada_l" });

function account() {
  return screen.getByRole("navigation", { name: "Account" });
}

it("shows Sign in and Create account to a visitor", async () => {
  apiRoutes();
  renderApp("/");

  expect(await within(account()).findByRole("link", { name: "Sign in" })).toBeTruthy();
  expect(within(account()).getByRole("link", { name: "Create account" })).toBeTruthy();
  expect(within(account()).queryByRole("button")).toBeNull();
});

it("shows a learner their username as plain text and a Sign out button", async () => {
  apiRoutes({ "GET /api/auth/me": learner });
  renderApp("/");

  expect(await within(account()).findByText("ada_l")).toBeTruthy();
  expect(within(account()).getByRole("button", { name: "Sign out" })).toBeTruthy();
  expect(within(account()).queryByRole("link")).toBeNull();
});

it("shows neither the username nor the sign-in links until /me has answered", async () => {
  const pending = deferred<Response>();
  apiRoutes({ "GET /api/auth/me": () => pending.promise });
  renderApp("/");

  expect(within(account()).queryByRole("link")).toBeNull();
  expect(within(account()).queryByRole("button")).toBeNull();
  expect(account().textContent).toBe("");
});

it("never has Sign in in the document before /me answers for a signed-in learner", async () => {
  const pending = deferred<Response>();
  apiRoutes({ "GET /api/auth/me": () => pending.promise });
  renderApp("/");
  const seen: boolean[] = [];
  const observer = new MutationObserver(() => seen.push(document.body.textContent?.includes("Sign in") ?? false));
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  expect(screen.queryByText("Sign in")).toBeNull();
  pending.resolve(learner());
  await within(account()).findByText("ada_l");
  observer.disconnect();

  expect(seen).not.toContain(true);
});

it("carries the current page as next on the header links", async () => {
  apiRoutes();
  renderApp("/courses/x/lessons/y");

  const signIn = await within(account()).findByRole("link", { name: "Sign in" });
  expect(signIn.getAttribute("href")).toBe("/login?next=/courses/x/lessons/y");
  expect(within(account()).getByRole("link", { name: "Create account" }).getAttribute("href")).toBe(
    "/register?next=/courses/x/lessons/y",
  );
});

it("keeps the query and hash of the current page inside next", async () => {
  apiRoutes();
  renderApp("/courses/x?tab=1#top");

  const signIn = await within(account()).findByRole("link", { name: "Sign in" });
  expect(signIn.getAttribute("href")).toBe("/login?next=/courses/x%3Ftab%3D1%23top");
});

it.each(["/login", "/register"])("carries the next already present on %s, not the form page itself", async (url) => {
  apiRoutes();
  renderApp(`${url}?next=/courses/x`);

  const signIn = await within(account()).findByRole("link", { name: "Sign in" });
  expect(signIn.getAttribute("href")).toBe("/login?next=/courses/x");
  expect(within(account()).getByRole("link", { name: "Create account" }).getAttribute("href")).toBe(
    "/register?next=/courses/x",
  );
});

it.each(["/login", "/register"])("has no next on the header links at %s without one", async (url) => {
  apiRoutes();
  renderApp(url);

  const signIn = await within(account()).findByRole("link", { name: "Sign in" });
  expect(signIn.getAttribute("href")).toBe("/login");
  expect(within(account()).getByRole("link", { name: "Create account" }).getAttribute("href")).toBe("/register");
});

it("signs out: visitor header, back to the course list, focus on the h1", async () => {
  const api = apiRoutes({
    "GET /api/auth/me": learner,
    "POST /api/auth/logout": () => new Response(null, { status: 204 }),
  });
  const { user, currentUrl, history } = renderApp("/courses/x/lessons/y");

  await user.click(await within(account()).findByRole("button", { name: "Sign out" }));

  expect(await within(account()).findByRole("link", { name: "Sign in" })).toBeTruthy();
  expect(within(account()).queryByText("ada_l")).toBeNull();
  // The header changes before the navigation that follows it, so wait for the effects that record it.
  await waitFor(() => expect(currentUrl()).toBe("/"));
  expect(history.at(-1)?.type).toBe("PUSH");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Courses" })));
  expect(api.calls("POST /api/auth/logout")).toHaveLength(1);
});

it("signs out and focuses the h1 even when already on the course list", async () => {
  apiRoutes({
    "GET /api/auth/me": learner,
    "POST /api/auth/logout": () => new Response(null, { status: 204 }),
  });
  const { user, currentUrl } = renderApp("/");

  await user.click(await within(account()).findByRole("button", { name: "Sign out" }));

  expect(await within(account()).findByRole("link", { name: "Sign in" })).toBeTruthy();
  expect(currentUrl()).toBe("/");
  expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Courses" }));
});

it("disables the button and says Signing out… while the request runs, and sends one request for two clicks", async () => {
  const pending = deferred<Response>();
  const api = apiRoutes({ "GET /api/auth/me": learner, "POST /api/auth/logout": () => pending.promise });
  const { user } = renderApp("/");

  await user.dblClick(await within(account()).findByRole("button", { name: "Sign out" }));

  const busy = within(account()).getByRole("button", { name: "Signing out…" });
  expect((busy as HTMLButtonElement).disabled).toBe(true);
  pending.resolve(new Response(null, { status: 204 }));
  await within(account()).findByRole("link", { name: "Sign in" });
  expect(api.calls("POST /api/auth/logout")).toHaveLength(1);
});

it.each([
  ["a network error", () => Promise.reject(new TypeError("Failed to fetch")), NETWORK_ERROR_MESSAGE],
  ["a 500", () => errorResponse(500, "internal_error", "Server broke."), "Server broke."],
  ["an HTML 502", () => htmlResponse(502), UNEXPECTED_RESPONSE_MESSAGE],
])("keeps the learner signed in and shows a banner when sign-out fails with %s", async (_name, answer, message) => {
  apiRoutes({ "GET /api/auth/me": learner, "POST /api/auth/logout": answer });
  const { user, currentUrl } = renderApp("/courses/x");

  await user.click(await within(account()).findByRole("button", { name: "Sign out" }));

  const banner = await screen.findByRole("alert");
  expect(within(banner).getByText(message)).toBeTruthy();
  expect(within(account()).getByText("ada_l")).toBeTruthy();
  expect(currentUrl()).toBe("/courses/x");
  await waitFor(() => {
    expect(document.activeElement).toBe(within(account()).getByRole("button", { name: "Sign out" }));
  });
});

it("retries sign-out when Sign out is pressed again after a failure", async () => {
  let attempt = 0;
  const api = apiRoutes({
    "GET /api/auth/me": learner,
    "POST /api/auth/logout": () => {
      attempt += 1;
      return attempt === 1 ? errorResponse(500, "internal_error", "Server broke.") : new Response(null, { status: 204 });
    },
  });
  const { user } = renderApp("/");
  await user.click(await within(account()).findByRole("button", { name: "Sign out" }));
  await screen.findByRole("alert");

  await user.click(within(account()).getByRole("button", { name: "Sign out" }));

  expect(await within(account()).findByRole("link", { name: "Sign in" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(api.calls("POST /api/auth/logout")).toHaveLength(2);
});
