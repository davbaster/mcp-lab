import { screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { NETWORK_ERROR_MESSAGE, UNEXPECTED_RESPONSE_MESSAGE } from "../api/apiError";
import { apiRoutes, deferred } from "../test/apiRoutes";
import { errorResponse, htmlResponse, jsonResponse } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

const courses = [
  { id: "zeta", title: "Zeta course", description: "Comes first from the API.", chapter_count: 6 },
  { id: "alpha", title: "Alpha course", description: "Comes second.", chapter_count: 1 },
];

it("shows each course in API order with a link, its description and its chapter count", async () => {
  apiRoutes({ "GET /api/courses": () => jsonResponse({ courses }) });
  renderApp("/");

  const items = await screen.findAllByRole("listitem");
  expect(items).toHaveLength(2);
  const first = within(items[0]);
  expect(first.getByRole("link", { name: "Zeta course" }).getAttribute("href")).toBe("/courses/zeta");
  expect(first.getByText("Comes first from the API.")).toBeTruthy();
  expect(first.getByText("6 chapters")).toBeTruthy();
  expect(within(items[1]).getByRole("link", { name: "Alpha course" })).toBeTruthy();
});

it("writes a chapter count of one in the singular", async () => {
  apiRoutes({ "GET /api/courses": () => jsonResponse({ courses }) });
  renderApp("/");

  expect(await screen.findByText("1 chapter")).toBeTruthy();
});

it("URL-encodes the course id in its link", async () => {
  apiRoutes({
    "GET /api/courses": () =>
      jsonResponse({ courses: [{ id: "a b/c", title: "Odd id", description: "d", chapter_count: 2 }] }),
  });
  renderApp("/");

  const link = await screen.findByRole("link", { name: "Odd id" });
  expect(link.getAttribute("href")).toBe("/courses/a%20b%2Fc");
});

it("shows Loading… with role status while the courses load", async () => {
  const slow = deferred<Response>();
  apiRoutes({ "GET /api/courses": () => slow.promise });
  renderApp("/");

  expect(screen.getByRole("status").textContent).toBe("Loading…");
  slow.resolve(jsonResponse({ courses }));
  expect(await screen.findByText("Zeta course")).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
});

it("says there are no courses yet for an empty list", async () => {
  apiRoutes({ "GET /api/courses": () => jsonResponse({ courses: [] }) });
  renderApp("/");

  expect(await screen.findByText("No courses available yet.")).toBeTruthy();
  expect(screen.queryByRole("list")).toBeNull();
});

it("shows the server message and Try again for a 500", async () => {
  apiRoutes({ "GET /api/courses": () => errorResponse(500, "internal_error", "Server broke.") });
  renderApp("/");

  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("Server broke.")).toBeTruthy();
  expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
});

it("shows the generic network message when the request cannot be sent", async () => {
  apiRoutes({ "GET /api/courses": () => Promise.reject(new TypeError("Failed to fetch")) });
  renderApp("/");

  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText(NETWORK_ERROR_MESSAGE)).toBeTruthy();
});

it("shows the generic message for a 502 HTML page", async () => {
  apiRoutes({ "GET /api/courses": () => htmlResponse(502) });
  renderApp("/");

  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText(UNEXPECTED_RESPONSE_MESSAGE)).toBeTruthy();
  expect(document.body.textContent).not.toContain("Bad Gateway");
});

it("repeats the request when Try again is pressed, showing Loading… meanwhile", async () => {
  let attempt = 0;
  const second = deferred<Response>();
  const api = apiRoutes({
    "GET /api/courses": () => {
      attempt += 1;
      return attempt === 1 ? errorResponse(500, "internal_error", "Server broke.") : second.promise;
    },
  });
  const { user } = renderApp("/");
  await user.click(await screen.findByRole("button", { name: "Try again" }));

  expect(screen.getByRole("status").textContent).toBe("Loading…");
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  second.resolve(jsonResponse({ courses }));
  expect(await screen.findByText("Zeta course")).toBeTruthy();
  expect(api.calls("GET /api/courses")).toHaveLength(2);
});

it("moves focus to the results region when Try again is pressed", async () => {
  let attempt = 0;
  apiRoutes({
    "GET /api/courses": () => {
      attempt += 1;
      return attempt === 1 ? errorResponse(500, "internal_error", "Server broke.") : jsonResponse({ courses });
    },
  });
  const { user } = renderApp("/");
  await user.click(await screen.findByRole("button", { name: "Try again" }));

  await screen.findByText("Zeta course");
  expect(document.activeElement).toBe(screen.getByRole("region", { name: "Course list" }));
});
