import { describe, expect, it } from "vitest";
import { httpsUrl, siteOrHttpsSource } from "./urls";

describe("httpsUrl", () => {
  it.each([
    ["https://media.mcp-lab.example/a.mp4", "https://media.mcp-lab.example/a.mp4"],
    ["HTTPS://Media.MCP-Lab.example/a.mp4", "https://media.mcp-lab.example/a.mp4"],
    ["https://media.mcp-lab.example", "https://media.mcp-lab.example/"],
    ["https://media.mcp-lab.example:8443/a.mp4?x=1#t", "https://media.mcp-lab.example:8443/a.mp4?x=1#t"],
  ])("accepts %s as %s", (value, href) => {
    expect(httpsUrl(value)?.href).toBe(href);
  });

  it.each([
    "http://media.mcp-lab.example/a.mp4",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:video/mp4;base64,AAAA",
    "blob:https://media.mcp-lab.example/uuid",
    "file:///etc/passwd",
    "//media.mcp-lab.example/a.mp4",
    "/a.mp4",
    "a.mp4",
    "https:media.mcp-lab.example/a.mp4",
    "https:/media.mcp-lab.example/a.mp4",
    "https://",
    "https://user@media.mcp-lab.example/a.mp4",
    "https://user:pw@media.mcp-lab.example/a.mp4",
    "https://media.mcp-lab.example@evil.example/a.mp4",
    "https://media.mcp-lab.example/a b.mp4",
    " https://media.mcp-lab.example/a.mp4",
    "https://media.mcp-lab.example/a.mp4\n",
    "https://media.mcp-lab.example/\ta.mp4",
    "https://media.mcp-lab.example/\u0000a.mp4",
    "https://media.mcp-lab.example\\evil.example/a.mp4",
    "https://media.mcp-lab.example/a b.mp4",
    "",
  ])("refuses %j", (value) => {
    expect(httpsUrl(value)).toBeNull();
  });

  it.each([undefined, null, 3, true, {}, ["https://media.mcp-lab.example/a.mp4"]])("refuses a value that is not a string: %j", (value) => {
    expect(httpsUrl(value)).toBeNull();
  });
});

describe("siteOrHttpsSource", () => {
  it("returns a site path as written and an https URL as parsed", () => {
    expect(siteOrHttpsSource("/api/courses/c/assets/a.vtt")).toBe("/api/courses/c/assets/a.vtt");
    expect(siteOrHttpsSource("https://Media.example/a.vtt")).toBe("https://media.example/a.vtt");
  });

  it.each(["//host/a.vtt", "http://host/a.vtt", "a.vtt", "javascript:alert(1)", "", null, 1])("refuses %j", (value) => {
    expect(siteOrHttpsSource(value)).toBeNull();
  });
});
