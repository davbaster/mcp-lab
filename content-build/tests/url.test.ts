// The one URL rule, used for Markdown links, Markdown images, and the URL props of components.

import { describe, expect, it } from "vitest";
import { urlProblem } from "../src/url.ts";

describe("urlProblem", () => {
  it.each([
    "../a.md",
    "/x",
    "#section",
    "?q=1",
    "images/pic.png",
    "./a:b",
    "a/b:c",
    "",
    "http://example.com/a",
    "https://example.com/a?b=c#d",
    "HTTPS://EXAMPLE.COM",
    "mailto:a@example.com",
    "MailTo:a@example.com",
    "https://example.com/a//b",
    "/a//b",
  ])("accepts %j", (url) => {
    expect(urlProblem(url)).toBeUndefined();
  });

  it.each([
    ["javascript:alert(1)", "javascript"],
    ["JavaScript:alert(1)", "JavaScript"],
    ["JAVASCRIPT:alert(1)", "JAVASCRIPT"],
    ["data:text/html;base64,AAAA", "data"],
    ["DATA:text/html,x", "DATA"],
    ["vbscript:msgbox(1)", "vbscript"],
    ["VbScript:x", "VbScript"],
    ["file:///etc/passwd", "file"],
    ["FILE:///etc/passwd", "FILE"],
    ["ftp://example.com/", "ftp"],
    ["tel:+123", "tel"],
    ["blob:https://example.com/x", "blob"],
    ["c:\\windows\\system32", "c"],
  ])("rejects the scheme in %j", (url, scheme) => {
    expect(urlProblem(url)).toBe(`the URL scheme \`${scheme}:\` is not allowed; use http, https, mailto, or a relative URL`);
  });

  it.each([
    [" javascript:alert(1)", "a space before"],
    ["   javascript:alert(1)", "spaces before"],
    ["\tjavascript:alert(1)", "a tab before"],
    ["\njavascript:alert(1)", "a line break before"],
    ["\u0001javascript:alert(1)", "a control character before"],
    ["\u0000\u001f javascript:alert(1)", "controls and a space before"],
    ["\u007fjavascript:alert(1)", "DEL before"],
    ["\u00a0javascript:alert(1)", "a no-break space before"],
    ["\ufeffjavascript:alert(1)", "a byte order mark before"],
    ["\u200bjavascript:alert(1)", "a zero-width space before"],
    ["java\tscript:alert(1)", "a tab inside the scheme"],
    ["java\nscript:alert(1)", "a line break inside the scheme"],
    ["java\r\nscript:alert(1)", "CRLF inside the scheme"],
    [" \tJaVaScRiPt:alert(1)", "mixed case after spaces"],
    [" data:text/html,x", "data after a space"],
  ])("rejects %j (%s)", (url) => {
    expect(urlProblem(url)).toMatch(/^the URL scheme `[A-Za-z]+:` is not allowed/);
  });

  it.each(["//evil.example/a", "//", " //evil.example", "\t//evil.example", "/\\evil.example", "\\\\evil.example", "\\/evil.example"])(
    "rejects the protocol-relative URL %j",
    (url) => {
      expect(urlProblem(url)).toBe(
        "a URL that starts with `//` is not allowed; write the whole http or https address, or a path that starts with one `/`",
      );
    },
  );
});
