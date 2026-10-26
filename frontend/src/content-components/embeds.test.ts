import { describe, expect, it } from "vitest";
import config from "../../../content-build/media-config.json";
import { EMBED_RULES, embedSource } from "./embeds";

const embed = (value: string) => embedSource(new URL(value));

describe("the embed rules", () => {
  it("are the embeds of content-build/media-config.json: one list", () => {
    expect(EMBED_RULES).toEqual(config.embeds.map(({ origin, pathPrefix }) => ({ origin, pathPrefix })));
    expect(EMBED_RULES.length).toBeGreaterThan(0);
  });

  it("do not carry the media origins or other keys of the file", () => {
    expect(JSON.stringify(EMBED_RULES)).not.toContain("mediaOrigins");
    for (const rule of EMBED_RULES) expect(Object.keys(rule).sort()).toEqual(["origin", "pathPrefix"]);
  });
});

describe("embedSource", () => {
  it("accepts an origin and path of a rule", () => {
    for (const rule of EMBED_RULES) expect(embed(`${rule.origin}${rule.pathPrefix}abc`)).toBe(`${rule.origin}${rule.pathPrefix}abc`);
  });

  it.each([
    "https://media.mcp-lab.example/embed/abc",
    "https://www.youtube-nocookie.com/watch?v=abc",
    "https://www.youtube-nocookie.com/embed",
    "https://www.youtube-nocookie.com.evil.example/embed/abc",
    "https://evil.example/https://www.youtube-nocookie.com/embed/abc",
    "https://www.youtube-nocookie.com:8443/embed/abc",
    "https://player.vimeo.com/embed/abc",
  ])("refuses %s", (value) => {
    expect(embed(value)).toBeNull();
  });

  it("uses the parsed origin, so a look-alike host or credentials do not match", () => {
    expect(embed("https://www.youtube-nocookie.com@evil.example/embed/abc")).toBeNull();
    expect(embed("https://www.youtube-nocookie.com%2eevil.example/embed/abc")).toBeNull();
  });

  it("matches a path prefix that was written with dot segments by what the browser reads", () => {
    expect(embed("https://www.youtube-nocookie.com/other/../embed/abc")).toBe("https://www.youtube-nocookie.com/embed/abc");
    expect(embed("https://www.youtube-nocookie.com/embed/../watch")).toBeNull();
  });

  it("removes autoplay in any case and spelling and keeps the rest", () => {
    expect(embed("https://player.vimeo.com/video/1?autoplay=1&h=abc&t=30s#t=5")).toBe("https://player.vimeo.com/video/1?h=abc&t=30s#t=5");
    expect(embed("https://player.vimeo.com/video/1?AUTOPLAY=1")).toBe("https://player.vimeo.com/video/1");
    expect(embed("https://player.vimeo.com/video/1?a=autoplay&autoplay=1")).toBe("https://player.vimeo.com/video/1?a=autoplay");
    expect(embed("https://player.vimeo.com/video/1?autoplay%3D1")).toBe("https://player.vimeo.com/video/1?autoplay%3D1");
  });

  it("works with rules that are passed in", () => {
    const rules = [{ origin: "https://video.example", pathPrefix: "/e/" }];
    expect(embedSource(new URL("https://video.example/e/1?autoplay=1"), rules)).toBe("https://video.example/e/1");
    expect(embedSource(new URL("https://www.youtube-nocookie.com/embed/abc"), rules)).toBeNull();
    expect(embedSource(new URL("https://www.youtube-nocookie.com/embed/abc"), [])).toBeNull();
  });
});
