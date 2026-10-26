import { screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { NETWORK_ERROR_MESSAGE, UNEXPECTED_RESPONSE_MESSAGE } from "../api/apiError";
import { apiRoutes, deferred } from "../test/apiRoutes";
import { errorResponse, htmlResponse, jsonResponse } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

const USERNAME_MESSAGE = "Username must be 4 to 8 characters: letters, digits, and underscores.";
const PASSWORD_MESSAGE = "Password must be 8 to 12 characters.";
const SENTINEL = "PASSWORD-SENTINEL-7f3a";
const SHORT_SENTINEL = "PWSENT-7f3a";

const username = () => screen.getByLabelText("Username") as HTMLInputElement;
const password = () => screen.getByLabelText("Password") as HTMLInputElement;

async function typeInto(user: UserEvent, field: HTMLElement, text: string) {
  await user.click(field);
  await user.paste(text);
}

async function fillIn(user: UserEvent, name: string, secret: string) {
  await typeInto(user, await screen.findByLabelText("Username"), name);
  await typeInto(user, password(), secret);
}

function submitButton(mode: "login" | "register") {
  return screen.getByRole("button", { name: mode === "login" ? /^Sign in|^Signing in/ : /^Create account|^Creating account/ });
}

function describedBy(element: HTMLElement): string[] {
  const ids = element.getAttribute("aria-describedby")?.split(" ") ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent ?? "");
}

const registered = () => jsonResponse({ username: "ada_l" }, 201);
const signedIn = () => jsonResponse({ username: "ada_l" });

// --- form structure --------------------------------------------------------------------------

it("renders the sign-in form with the required attributes", async () => {
  apiRoutes();
  renderApp("/login");

  const form = (await screen.findByLabelText("Username")).closest("form") as HTMLFormElement;
  expect(form.getAttribute("method")).toBe("post");
  expect(form.noValidate).toBe(true);
  expect(username().type).toBe("text");
  expect(username().name).toBe("username");
  expect(username().getAttribute("autocomplete")).toBe("username");
  expect(username().getAttribute("autocapitalize")).toBe("none");
  expect(username().getAttribute("spellcheck")).toBe("false");
  expect(password().type).toBe("password");
  expect(password().name).toBe("password");
  expect(password().getAttribute("autocomplete")).toBe("current-password");
  expect(screen.queryByText("4 to 8 letters, digits, or underscores")).toBeNull();
});

it("renders the register form with new-password and hints linked with aria-describedby", async () => {
  apiRoutes();
  renderApp("/register");

  await screen.findByLabelText("Username");
  expect(password().getAttribute("autocomplete")).toBe("new-password");
  expect(username().getAttribute("autocomplete")).toBe("username");
  expect(describedBy(username())).toEqual(["4 to 8 letters, digits, or underscores"]);
  expect(describedBy(password())).toEqual(["8 to 12 characters"]);
});

it.each(["/login", "/register"])("shows Loading… and no form at %s until /me answers", async (url) => {
  const pending = deferred<Response>();
  apiRoutes({ "GET /api/auth/me": () => pending.promise });
  renderApp(url);

  expect(screen.getByRole("status").textContent).toBe("Loading…");
  expect(screen.queryByLabelText("Username")).toBeNull();
  expect(screen.queryByRole("button", { name: /Sign in|Create account/ })).toBeNull();
  pending.resolve(errorResponse(401, "not_authenticated", "Sign in to continue."));
  expect(await screen.findByLabelText("Username")).toBeTruthy();
});

it("never shows the form to a signed-in learner at /login", async () => {
  apiRoutes({ "GET /api/auth/me": signedIn });
  renderApp("/login");

  expect(await screen.findByRole("heading", { level: 1, name: "Courses" })).toBeTruthy();
  expect(screen.queryByLabelText("Username")).toBeNull();
});

it("links sign in and register to each other and keeps next", async () => {
  apiRoutes();
  const first = renderApp("/login?next=%2Fcourses%2Fx");
  const create = await screen.findByRole("link", { name: "Create one" });
  expect(create.getAttribute("href")).toBe("/register?next=/courses/x");
  first.unmount();

  renderApp("/register?next=%2Fcourses%2Fx");
  const signIn = await screen.findAllByRole("link", { name: "Sign in" });
  expect(signIn.map((link) => link.getAttribute("href"))).toEqual(["/login?next=/courses/x", "/login?next=/courses/x"]);
  expect(screen.getByText(/Already have an account\?/)).toBeTruthy();
});

it("links to the other page without next when there is none", async () => {
  apiRoutes();
  renderApp("/login");

  expect((await screen.findByRole("link", { name: "Create one" })).getAttribute("href")).toBe("/register");
  expect(screen.getByText(/No account yet\?/)).toBeTruthy();
});

// --- register rules --------------------------------------------------------------------------

it("rejects a username shorter than 4 characters without sending anything", async () => {
  const api = apiRoutes();
  const { user } = renderApp("/register");
  await fillIn(user, "abc", "secret-pass");

  await user.click(submitButton("register"));

  expect(screen.getByText(USERNAME_MESSAGE)).toBeTruthy();
  expect(screen.queryByText(PASSWORD_MESSAGE)).toBeNull();
  expect(api.calls("POST /api/auth/register")).toHaveLength(0);
});

it.each(["abcdefghi", "ab-cd", "ab cd", "abcé", " abcd", "abcd "])(
  "rejects the username %j without sending anything",
  async (name) => {
    const api = apiRoutes();
    const { user } = renderApp("/register");
    await fillIn(user, name, "secret-pass");

    await user.click(submitButton("register"));

    expect(screen.getByText(USERNAME_MESSAGE)).toBeTruthy();
    expect(api.calls("POST /api/auth/register")).toHaveLength(0);
  },
);

it.each(["abcd", "abcdefgh", "Ab_1", "A_B_C_D_"])("accepts the username %j", async (name) => {
  const api = apiRoutes({ "POST /api/auth/register": registered });
  const { user } = renderApp("/register");
  await fillIn(user, name, "secret-pass");

  await user.click(submitButton("register"));

  await screen.findByRole("heading", { level: 1, name: "Courses" });
  expect(api.calls("POST /api/auth/register")).toHaveLength(1);
});

it.each(["1234567", "1234567890123", ""])("rejects the password %j without sending anything", async (secret) => {
  const api = apiRoutes();
  const { user } = renderApp("/register");
  await fillIn(user, "ada_l", secret);

  await user.click(submitButton("register"));

  expect(screen.getByText(PASSWORD_MESSAGE)).toBeTruthy();
  expect(screen.queryByText(USERNAME_MESSAGE)).toBeNull();
  expect(api.calls("POST /api/auth/register")).toHaveLength(0);
});

it.each(["12345678", "123456789012", "with spaces!"])("accepts the password %j", async (secret) => {
  const api = apiRoutes({ "POST /api/auth/register": registered });
  const { user } = renderApp("/register");
  await fillIn(user, "ada_l", secret);

  await user.click(submitButton("register"));

  await screen.findByRole("heading", { level: 1, name: "Courses" });
  expect(api.calls("POST /api/auth/register")).toHaveLength(1);
});

it("counts an emoji as one character in the password", async () => {
  const api = apiRoutes({ "POST /api/auth/register": registered });
  const { user } = renderApp("/register");
  // Eight emoji are eight characters (sixteen UTF-16 units): valid.
  await fillIn(user, "ada_l", "😀".repeat(8));

  await user.click(submitButton("register"));

  await screen.findByRole("heading", { level: 1, name: "Courses" });
  expect(api.calls("POST /api/auth/register")).toHaveLength(1);
});

it("rejects seven emoji, which are only seven characters although they are fourteen UTF-16 units", async () => {
  const api = apiRoutes();
  const { user } = renderApp("/register");
  await fillIn(user, "ada_l", "😀".repeat(7));

  await user.click(submitButton("register"));

  expect(screen.getByText(PASSWORD_MESSAGE)).toBeTruthy();
  expect(api.calls("POST /api/auth/register")).toHaveLength(0);
});

it("counts the ligature ﬁ as two characters after NFKC, so four of them are valid", async () => {
  const api = apiRoutes({ "POST /api/auth/register": registered });
  const { user } = renderApp("/register");
  await fillIn(user, "ada_l", "ﬁﬁﬁﬁ");

  await user.click(submitButton("register"));

  await screen.findByRole("heading", { level: 1, name: "Courses" });
  expect(api.calls("POST /api/auth/register")).toHaveLength(1);
});

it("rejects seven ﬁ ligatures, which are fourteen characters after NFKC", async () => {
  const api = apiRoutes();
  const { user } = renderApp("/register");
  await fillIn(user, "ada_l", "ﬁ".repeat(7));

  await user.click(submitButton("register"));

  expect(screen.getByText(PASSWORD_MESSAGE)).toBeTruthy();
  expect(api.calls("POST /api/auth/register")).toHaveLength(0);
});

it("shows both register messages at once, marks both fields invalid and focuses the username", async () => {
  apiRoutes();
  const { user } = renderApp("/register");
  await fillIn(user, "ab", "short");

  await user.click(submitButton("register"));

  expect(username().getAttribute("aria-invalid")).toBe("true");
  expect(password().getAttribute("aria-invalid")).toBe("true");
  expect(describedBy(username())).toContain(USERNAME_MESSAGE);
  expect(describedBy(password())).toContain(PASSWORD_MESSAGE);
  expect(document.activeElement).toBe(username());
});

it("focuses the password when only the password is invalid", async () => {
  apiRoutes();
  const { user } = renderApp("/register");
  await fillIn(user, "ada_l", "short");

  await user.click(submitButton("register"));

  expect(document.activeElement).toBe(password());
  expect(username().getAttribute("aria-invalid")).toBeNull();
});

it("removes a field's error when that field is edited, and keeps the other", async () => {
  apiRoutes();
  const { user } = renderApp("/register");
  await fillIn(user, "ab", "short");
  await user.click(submitButton("register"));

  await user.type(username(), "cd");

  expect(screen.queryByText(USERNAME_MESSAGE)).toBeNull();
  expect(username().getAttribute("aria-invalid")).toBeNull();
  expect(screen.getByText(PASSWORD_MESSAGE)).toBeTruthy();
});

// --- sign-in rules ---------------------------------------------------------------------------

it("checks only that both sign-in fields are not empty", async () => {
  const api = apiRoutes();
  const { user } = renderApp("/login");
  await screen.findByLabelText("Username");

  await user.click(submitButton("login"));

  expect(screen.getByText("Enter your username.")).toBeTruthy();
  expect(screen.getByText("Enter your password.")).toBeTruthy();
  expect(document.activeElement).toBe(username());
  expect(api.calls("POST /api/auth/login")).toHaveLength(0);
});

it("asks only for the password when the username is filled in", async () => {
  apiRoutes();
  const { user } = renderApp("/login");
  await typeInto(user, await screen.findByLabelText("Username"), "ab");

  await user.click(submitButton("login"));

  expect(screen.queryByText("Enter your username.")).toBeNull();
  expect(screen.getByText("Enter your password.")).toBeTruthy();
  expect(document.activeElement).toBe(password());
});

it("does not apply the register rules to sign in", async () => {
  const api = apiRoutes({ "POST /api/auth/login": signedIn });
  const { user } = renderApp("/login");
  await fillIn(user, "x", "y");

  await user.click(submitButton("login"));

  await screen.findByRole("heading", { level: 1, name: "Courses" });
  expect(api.calls("POST /api/auth/login")[0].body).toEqual({ username: "x", password: "y" });
});

// --- requests --------------------------------------------------------------------------------

it.each([
  ["login", "/login", "POST /api/auth/login", signedIn],
  ["register", "/register", "POST /api/auth/register", registered],
] as const)("sends exactly username and password for %s, with no extra headers or credentials option", async (mode, url, route, answer) => {
  const api = apiRoutes({ [route]: answer });
  const { user } = renderApp(url);
  await fillIn(user, "ada_l", "secret-pass");

  await user.click(submitButton(mode));

  await screen.findByRole("heading", { level: 1, name: "Courses" });
  const [call] = api.calls(route);
  expect(call.body).toEqual({ username: "ada_l", password: "secret-pass" });
  expect(Object.keys(call.headers).filter((name) => name !== "content-type")).toEqual([]);
  expect(call.credentials).toBe("same-origin");
});

it("does not trim the username it sends", async () => {
  const api = apiRoutes({ "POST /api/auth/login": signedIn });
  const { user } = renderApp("/login");
  await fillIn(user, " ada_l ", " secret ");

  await user.click(submitButton("login"));

  await screen.findByRole("heading", { level: 1, name: "Courses" });
  expect(api.calls("POST /api/auth/login")[0].body).toEqual({ username: " ada_l ", password: " secret " });
});

it.each(["username", "password"] as const)("submits the form when Enter is pressed in the %s field", async (field) => {
  const api = apiRoutes({ "POST /api/auth/login": signedIn });
  const { user } = renderApp("/login");
  await fillIn(user, "ada_l", "secret-pass");

  await user.click(field === "username" ? username() : password());
  await user.keyboard("{Enter}");

  await screen.findByRole("heading", { level: 1, name: "Courses" });
  expect(api.calls("POST /api/auth/login")).toHaveLength(1);
});

it.each([
  ["login", "/login", "POST /api/auth/login", "Signing in…"],
  ["register", "/register", "POST /api/auth/register", "Creating account…"],
] as const)("disables the %s button and changes its label while the request runs", async (mode, url, route, busy) => {
  const pending = deferred<Response>();
  apiRoutes({ [route]: () => pending.promise });
  const { user } = renderApp(url);
  await fillIn(user, "ada_l", "secret-pass");

  await user.click(submitButton(mode));

  const button = screen.getByRole("button", { name: busy }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  pending.resolve(mode === "login" ? signedIn() : registered());
  await screen.findByRole("heading", { level: 1, name: "Courses" });
});

it("sends one request for two clicks", async () => {
  const pending = deferred<Response>();
  const api = apiRoutes({ "POST /api/auth/login": () => pending.promise });
  const { user } = renderApp("/login");
  await fillIn(user, "ada_l", "secret-pass");

  await user.dblClick(submitButton("login"));

  expect(api.calls("POST /api/auth/login")).toHaveLength(1);
  pending.resolve(signedIn());
  await screen.findByRole("heading", { level: 1, name: "Courses" });
});

it("sends one request for two presses of Enter", async () => {
  const pending = deferred<Response>();
  const api = apiRoutes({ "POST /api/auth/login": () => pending.promise });
  const { user } = renderApp("/login");
  await fillIn(user, "ada_l", "secret-pass");

  await user.click(password());
  await user.keyboard("{Enter}{Enter}");

  expect(api.calls("POST /api/auth/login")).toHaveLength(1);
  pending.resolve(signedIn());
  await screen.findByRole("heading", { level: 1, name: "Courses" });
});

// --- server errors ---------------------------------------------------------------------------

it("shows username_taken below the username field and focuses it", async () => {
  apiRoutes({ "POST /api/auth/register": () => errorResponse(409, "username_taken", "That username is taken.") });
  const { user } = renderApp("/register");
  await fillIn(user, "ada_l", "secret-pass");

  await user.click(submitButton("register"));

  await screen.findByText("That username is taken.");
  expect(describedBy(username())).toContain("That username is taken.");
  expect(username().getAttribute("aria-invalid")).toBe("true");
  expect(document.activeElement).toBe(username());
  expect(screen.queryByRole("alert")).toBeNull();
  expect(username().value).toBe("ada_l");
  expect(password().value).toBe("secret-pass");
});

const boxCases: [string, "login" | "register", () => Response | Promise<Response>, string][] = [
  ["invalid_credentials", "login", () => errorResponse(401, "invalid_credentials", "Wrong username or password."), "Wrong username or password."],
  ["validation_error on sign in", "login", () => errorResponse(422, "validation_error", "Check your details."), "Check your details."],
  ["validation_error on register", "register", () => errorResponse(422, "validation_error", "Check your details."), "Check your details."],
  ["too_many_attempts", "login", () => errorResponse(429, "too_many_attempts", "Too many attempts.", { "Retry-After": "30" }), "Too many attempts."],
  ["internal_error on sign in", "login", () => errorResponse(500, "internal_error", "Server broke."), "Server broke."],
  ["internal_error on register", "register", () => errorResponse(500, "internal_error", "Server broke."), "Server broke."],
  ["an unknown code", "login", () => errorResponse(418, "teapot", "I am a teapot."), "I am a teapot."],
  ["a 502 HTML page on sign in", "login", () => htmlResponse(502), UNEXPECTED_RESPONSE_MESSAGE],
  ["a 502 HTML page on register", "register", () => htmlResponse(502), UNEXPECTED_RESPONSE_MESSAGE],
  ["a network error on sign in", "login", () => Promise.reject(new TypeError("Failed to fetch")), NETWORK_ERROR_MESSAGE],
  ["a network error on register", "register", () => Promise.reject(new TypeError("Failed to fetch")), NETWORK_ERROR_MESSAGE],
];

it.each(boxCases)("shows %s in an alert box above the form and keeps what was typed", async (_name, mode, answer, message) => {
  apiRoutes({ [mode === "login" ? "POST /api/auth/login" : "POST /api/auth/register"]: answer });
  const { user } = renderApp(mode === "login" ? "/login" : "/register");
  await fillIn(user, "ada_l", "secret-pass");

  await user.click(submitButton(mode));

  const box = await screen.findByRole("alert");
  expect(within(box).getByText(message)).toBeTruthy();
  const form = username().closest("form") as HTMLFormElement;
  expect(box.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(username().value).toBe("ada_l");
  expect(password().value).toBe("secret-pass");
  expect((submitButton(mode) as HTMLButtonElement).disabled).toBe(false);
});

it.each([
  ["1", "Try again in about 1 second."],
  ["59", "Try again in about 59 seconds."],
  ["60", "Try again in about 1 minute."],
  ["61", "Try again in about 2 minutes."],
  ["900", "Try again in about 15 minutes."],
])("tells the learner how long to wait for Retry-After %s", async (header, wait) => {
  apiRoutes({
    "POST /api/auth/login": () =>
      errorResponse(429, "too_many_attempts", "Too many failed attempts.", { "Retry-After": header }),
  });
  const { user } = renderApp("/login");
  await fillIn(user, "ada_l", "secret-pass");

  await user.click(submitButton("login"));

  const box = await screen.findByRole("alert");
  expect(within(box).getByText("Too many failed attempts.")).toBeTruthy();
  expect(within(box).getByText(wait)).toBeTruthy();
  expect((submitButton("login") as HTMLButtonElement).disabled).toBe(false);
});

it.each([["missing", undefined], ["abc", "abc"], ["0", "0"], ["1.5", "1.5"]])(
  "shows only the server message for a Retry-After that is %s",
  async (_name, header) => {
    apiRoutes({
      "POST /api/auth/login": () =>
        errorResponse(429, "too_many_attempts", "Too many failed attempts.", header ? { "Retry-After": header } : undefined),
    });
    const { user } = renderApp("/login");
    await fillIn(user, "ada_l", "secret-pass");

    await user.click(submitButton("login"));

    const box = await screen.findByRole("alert");
    expect(within(box).getByText("Too many failed attempts.")).toBeTruthy();
    expect(box.textContent).not.toContain("Try again in about");
  },
);

it("lets the learner try again after an error", async () => {
  let attempt = 0;
  const api = apiRoutes({
    "POST /api/auth/login": () => {
      attempt += 1;
      return attempt === 1 ? errorResponse(401, "invalid_credentials", "Wrong.") : signedIn();
    },
  });
  const { user } = renderApp("/login");
  await fillIn(user, "ada_l", "secret-pass");
  await user.click(submitButton("login"));
  await screen.findByText("Wrong.");

  await user.click(submitButton("login"));

  await screen.findByRole("heading", { level: 1, name: "Courses" });
  expect(api.calls("POST /api/auth/login")).toHaveLength(2);
});

// --- after success and the `next` target -----------------------------------------------------

it("shows the username from the response and makes no extra /me call after signing in", async () => {
  const api = apiRoutes({ "POST /api/auth/login": () => jsonResponse({ username: "from_server" }) });
  const { user } = renderApp("/login");
  await fillIn(user, "ada_l", "secret-pass");

  await user.click(submitButton("login"));

  const account = screen.getByRole("navigation", { name: "Account" });
  expect(await within(account).findByText("from_server")).toBeTruthy();
  expect(api.calls("GET /api/auth/me")).toHaveLength(1);
});

it("sends the learner to next with the history entry replaced and focus on the new h1", async () => {
  apiRoutes({ "POST /api/auth/login": signedIn });
  const { user, currentUrl, history } = renderApp("/login?next=%2Fcourses%2Fx");
  await fillIn(user, "ada_l", "secret-pass");

  await user.click(submitButton("login"));

  await screen.findByRole("heading", { level: 1, name: "Course dashboard" });
  await waitFor(() => expect(currentUrl()).toBe("/courses/x"));
  expect(history.at(-1)?.type).toBe("REPLACE");
  expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
});

const nextCases: [string, string][] = [
  ["%2Fcourses%2Fx", "/courses/x"],
  ["%2Fcourses%2Fx%3Ftab%3D1%23top", "/courses/x?tab=1#top"],
  ["%2Fcourses%2Fx&next=%2F%2Fevil.example", "/courses/x"],
  ["https://evil.example", "/"],
  ["//evil.example", "/"],
  ["%2F%2Fevil.example", "/"],
  ["/%5Cevil.example", "/"],
  ["javascript:alert(1)", "/"],
  ["/login", "/"],
  ["/register", "/"],
  ["", "/"],
];

for (const [flow, url, route, answer, mode] of [
  ["a fresh sign in", "/login", "POST /api/auth/login", signedIn, "login"],
  ["a fresh register", "/register", "POST /api/auth/register", registered, "register"],
] as const) {
  it.each(nextCases)(`after ${flow}, next=%s goes to %s`, async (raw, target) => {
    apiRoutes({ [route]: answer });
    const { user, currentUrl, history } = renderApp(`${url}?next=${raw}`);
    await fillIn(user, "ada_l", "secret-pass");

    await user.click(submitButton(mode));

    await waitFor(() => expect(currentUrl()).toBe(target));
    expect(history.at(-1)?.type).toBe("REPLACE");
  });
}

for (const page of ["/login", "/register"]) {
  it.each(nextCases)(`redirects a signed-in learner who opens ${page}?next=%s to %s`, async (raw, target) => {
    apiRoutes({ "GET /api/auth/me": signedIn });
    const { currentUrl, history } = renderApp(`${page}?next=${raw}`);

    await waitFor(() => expect(currentUrl()).toBe(target));
    expect(history.at(-1)?.type).toBe("REPLACE");
  });
}

it("goes to the course list when there is no next", async () => {
  apiRoutes({ "GET /api/auth/me": signedIn });
  const { currentUrl } = renderApp("/login");

  await screen.findByRole("heading", { level: 1, name: "Courses" });
  expect(currentUrl()).toBe("/");
});

// --- the password stays out of everything ----------------------------------------------------

const privacyCases: [string, "login" | "register", () => Response | Promise<Response>][] = [
  ["a wrong password", "login", () => errorResponse(401, "invalid_credentials", "Wrong username or password.")],
  ["a validation error", "login", () => errorResponse(422, "validation_error", "Check your details.")],
  ["a rate limit", "login", () => errorResponse(429, "too_many_attempts", "Too many attempts.", { "Retry-After": "900" })],
  ["a server error", "login", () => errorResponse(500, "internal_error", "Server broke.")],
  ["an HTML 502", "login", () => htmlResponse(502)],
  ["a network error", "login", () => Promise.reject(new TypeError("Failed to fetch"))],
  ["a taken username", "register", () => errorResponse(409, "username_taken", "That username is taken.")],
  ["a validation error on register", "register", () => errorResponse(422, "validation_error", "Check your details.")],
  ["a server error on register", "register", () => errorResponse(500, "internal_error", "Server broke.")],
  ["an HTML 502 on register", "register", () => htmlResponse(502)],
  ["a network error on register", "register", () => Promise.reject(new TypeError("Failed to fetch"))],
];

it.each(privacyCases)("never shows, stores or logs the password after %s", async (_name, mode, answer) => {
  const secret = mode === "login" ? SENTINEL : SHORT_SENTINEL;
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  apiRoutes({ [mode === "login" ? "POST /api/auth/login" : "POST /api/auth/register"]: answer });
  const { user, currentUrl } = renderApp(mode === "login" ? "/login" : "/register");
  await fillIn(user, "ada_l", secret);

  await user.click(submitButton(mode));

  await screen.findByRole("alert").catch(() => screen.findByText("That username is taken."));
  expect(password().value).toBe(secret); // still typed, so the sentinel is real
  expect(document.body.textContent).not.toContain(secret);
  expect(document.title).not.toContain(secret);
  expect(currentUrl()).not.toContain(secret);
  expect(window.location.href).not.toContain(secret);
  expect(setItem).not.toHaveBeenCalled();
  expect(JSON.stringify(Object.entries(localStorage))).not.toContain(secret);
  expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain(secret);
  expect(document.cookie).not.toContain(secret);
  for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
});

it("never shows the password after a client-side register error either", async () => {
  apiRoutes();
  const { user } = renderApp("/register");
  await fillIn(user, "ab", SENTINEL);

  await user.click(submitButton("register"));

  expect(await screen.findByText(PASSWORD_MESSAGE)).toBeTruthy();
  expect(document.body.textContent).not.toContain(SENTINEL);
  expect(document.title).not.toContain(SENTINEL);
});
