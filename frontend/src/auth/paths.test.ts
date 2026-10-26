import { describe, expect, it } from "vitest";
import { nextTarget, registerPath, returnTarget, signInPath } from "./paths";

it("builds a sign-in link that keeps the slashes of next readable", () => {
  expect(signInPath("/courses/x")).toBe("/login?next=/courses/x");
});

it("encodes the query and hash of next so they stay inside the value", () => {
  const link = signInPath("/courses/x?tab=1#top");

  expect(link).toBe("/login?next=/courses/x%3Ftab%3D1%23top");
  expect(new URL(link, "http://localhost").searchParams.get("next")).toBe("/courses/x?tab=1#top");
});

it("builds a plain sign-in link without next", () => {
  expect(signInPath()).toBe("/login");
  expect(signInPath("")).toBe("/login");
  expect(signInPath(null)).toBe("/login");
});

it("builds a register link the same way", () => {
  expect(registerPath("/courses/x")).toBe("/register?next=/courses/x");
  expect(registerPath()).toBe("/register");
});

it.each([
  ["/courses/x", "/courses/x"],
  ["/courses/x?tab=1#top", "/courses/x?tab=1#top"],
  ["/", "/"],
  ["https://evil.example", "/"],
  ["//evil.example", "/"],
  ["/\\evil.example", "/"],
  ["/a\\b", "/"],
  ["javascript:alert(1)", "/"],
  ["/login", "/"],
  ["/register", "/"],
  ["/login/", "/"],
  ["/login?next=/x", "/"],
  ["/LOGIN", "/"],
  ["", "/"],
  [null, "/"],
  [undefined, "/"],
  ["/a\tb", "/"],
  ["/a\nb", "/"],
  ["/a\u0000b", "/"],
  ["courses/x", "/"],
  ["/loginx", "/loginx"],
])("turns next %j into %j", (next, target) => {
  expect(nextTarget(next)).toBe(target);
});

describe("returnTarget", () => {
  const at = (pathname: string, search = "", hash = "") => returnTarget({ pathname, search, hash });

  it("is the path, query and hash of an ordinary page", () => {
    expect(at("/courses/x/lessons/y", "?tab=2", "#top")).toBe("/courses/x/lessons/y?tab=2#top");
    expect(at("/")).toBe("/");
  });

  it("is the page's own next value on the sign-in and register pages", () => {
    expect(at("/login", "?next=/courses/x")).toBe("/courses/x");
    expect(at("/register", "?next=%2Fcourses%2Fx%3Fa%3D1")).toBe("/courses/x?a=1");
    expect(at("/Login/", "?next=/courses/x")).toBe("/courses/x");
  });

  it("is null on those pages without a next value", () => {
    expect(at("/login")).toBeNull();
    expect(at("/register", "?other=1")).toBeNull();
  });
});
