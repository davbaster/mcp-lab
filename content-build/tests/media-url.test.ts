// Where a Video URL may point: parsed origin and path, never a string prefix.

import { describe, expect, it } from "vitest";
import { loadMediaConfig } from "../src/media-config.ts";
import { mediaUrlProblem } from "../src/media-url.ts";
import { mediaConfigFile } from "./asset-helpers.ts";

const CDN = "https://media.mcp-lab.example";
const config = loadMediaConfig();
const video = (value: string) => mediaUrlProblem(value, "video", config);

describe("Video.src", () => {
  it.each([
    `${CDN}/videos/intro.mp4`,
    `${CDN}/a.mp4?token=1#t=10`,
    "HTTPS://MEDIA.MCP-LAB.EXAMPLE/a.mp4",
    "https://Media.Mcp-Lab.Example/a.mp4",
    `${CDN}:443/a.mp4`,
    `${CDN}`,
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/abc_DEF-1?start=30",
    "https://player.vimeo.com/video/123456789",
    "https://player.vimeo.com/video/123?h=abcdef&autoplay=1",
  ])("accepts %s", (value) => {
    expect(video(value)).toBeUndefined();
  });

  it.each<[string, string, RegExp]>([
    ["http instead of https", "http://media.mcp-lab.example/a.mp4", /must start with https:\/\/ \(it uses `http:`\)/],
    ["a host that continues past the allowed one", "https://media.mcp-lab.example.evil.com/a.mp4", /origin https:\/\/media\.mcp-lab\.example\.evil\.com is not in media-config\.json/],
    ["a host that starts like the allowed one", "https://evil-media.mcp-lab.example/a.mp4", /is not in media-config\.json/],
    ["the allowed host as user name", "https://media.mcp-lab.example@evil.com/a.mp4", /credentials \(`user@`\)/],
    ["a user and password", "https://user:pw@media.mcp-lab.example/a.mp4", /credentials/],
    ["an empty user name", "https://@media.mcp-lab.example/a.mp4", /credentials/],
    ["the allowed URL in a query", "https://evil.com/?u=https://media.mcp-lab.example/a.mp4", /origin https:\/\/evil\.com is not in media-config\.json/],
    ["the allowed URL in the path", "https://evil.com/https://media.mcp-lab.example/a.mp4", /is not in media-config\.json/],
    ["a different port", "https://media.mcp-lab.example:8443/a.mp4", /origin https:\/\/media\.mcp-lab\.example:8443 is not in media-config\.json/],
    ["port 80", "https://media.mcp-lab.example:80/a.mp4", /is not in media-config\.json/],
    ["a trailing dot in the host", "https://media.mcp-lab.example./a.mp4", /is not in media-config\.json/],
    ["a percent-encoded dot in the host", "https://media.mcp-lab.example%2eevil.com/a.mp4", /is not in media-config\.json/],
    ["a look-alike letter in the host", "https://media.mcp-lab.exаmple/a.mp4", /is not in media-config\.json/],
    ["a space", "https://media.mcp-lab.example/a b.mp4", /space or a control character/],
    ["a tab", "https://media.mcp-lab.example/a\t.mp4", /space or a control character/],
    ["a line break", "https://media.mcp-lab.example/a\n.mp4", /space or a control character/],
    ["a control character", "https://media.mcp-lab.example/a\u0001.mp4", /space or a control character/],
    ["a backslash", "https://media.mcp-lab.example\\a.mp4", /backslash/],
    ["a backslash before an at sign", "https://media.mcp-lab.example\\@evil.com/a.mp4", /backslash/],
    ["a leading space", " https://media.mcp-lab.example/a.mp4", /space or a control character/],
    ["another scheme", "ftp://media.mcp-lab.example/a.mp4", /must start with https:\/\//],
    ["javascript:", "javascript:alert(1)", /must start with https:\/\//],
    ["mailto:", "mailto:a@example.com", /must start with https:\/\//],
    ["a scheme with the host missing (a.mp4 becomes the host)", "https:///a.mp4", /origin https:\/\/a\.mp4 is not in media-config\.json/],
    ["a scheme and nothing more", "https:", /not a valid address/],
    ["an embed address with no ID", "https://www.youtube-nocookie.com/embed/", /must be https:\/\/www\.youtube-nocookie\.com\/embed\/<id>/],
    ["an embed path with another prefix", "https://www.youtube-nocookie.com/watch/abc", /must be https:\/\/www\.youtube-nocookie\.com\/embed\/<id>/],
    ["an embed ID with a further segment", "https://www.youtube-nocookie.com/embed/abc/def", /must be https:\/\/www\.youtube-nocookie\.com\/embed\/<id>/],
    ["an embed ID with a trailing slash", "https://www.youtube-nocookie.com/embed/abc/", /must be https:\/\/www\.youtube-nocookie\.com\/embed\/<id>/],
    ["an embed ID with an encoded slash", "https://www.youtube-nocookie.com/embed/a%2Fb", /must be https:\/\/www\.youtube-nocookie\.com\/embed\/<id>/],
    ["an embed ID that leaves the prefix by a dot segment", "https://www.youtube-nocookie.com/embed/../other", /must be https:\/\/www\.youtube-nocookie\.com\/embed\/<id>/],
    ["a Vimeo ID that is not digits", "https://player.vimeo.com/video/abc", /must be https:\/\/player\.vimeo\.com\/video\/<id>/],
    ["a Vimeo ID with a second segment", "https://player.vimeo.com/video/123/456", /must be https:\/\/player\.vimeo\.com\/video\/<id>/],
    ["the Vimeo origin on another path", "https://player.vimeo.com/123", /must be https:\/\/player\.vimeo\.com\/video\/<id>/],
    ["a YouTube watch page", "https://www.youtube.com/watch?v=abc", /is a watch page.*use `https:\/\/www\.youtube-nocookie\.com\/embed\/<id>`/],
    ["a YouTube watch page without www", "https://youtube.com/watch?v=abc", /use `https:\/\/www\.youtube-nocookie\.com\/embed\/<id>`/],
    ["a mobile YouTube watch page", "https://m.youtube.com/watch?v=abc", /use `https:\/\/www\.youtube-nocookie\.com\/embed\/<id>`/],
    ["a short YouTube address", "https://youtu.be/abc", /use `https:\/\/www\.youtube-nocookie\.com\/embed\/<id>`/],
    ["a Vimeo page", "https://vimeo.com/123", /use `https:\/\/player\.vimeo\.com\/video\/<id>`/],
    ["a Vimeo page with www", "https://www.vimeo.com/123", /use `https:\/\/player\.vimeo\.com\/video\/<id>`/],
    ["a relative file name", "clip.mp4", /videos are not served from assets\/, so use a https URL on a media CDN or an embed URL/],
    ["a relative path", "videos/intro.mp4", /videos are not served from assets\//],
    ["a path from the root", "/videos/intro.mp4", /videos are not served from assets\//],
    ["a path in assets/", "assets/clip.mp4", /videos are not served from assets\//],
  ])("rejects %s", (_name, value, message) => {
    expect(video(value)).toMatch(message);
  });

  it("names the URL in the message", () => {
    expect(video("https://example.com/a.mp4")).toContain("`https://example.com/a.mp4`");
  });
});

describe("Video.captions and Video.poster", () => {
  const captions = (value: string) => mediaUrlProblem(value, "captions", config);
  const poster = (value: string) => mediaUrlProblem(value, "poster", config);

  it("accepts a URL on a media origin that ends in .vtt (the query is ignored) or in an image extension", () => {
    expect(captions(`${CDN}/c/intro.vtt`)).toBeUndefined();
    expect(captions(`${CDN}/c/intro.VTT?v=2`)).toBeUndefined();
    for (const extension of ["png", "jpg", "jpeg", "webp", "svg", "PNG"]) expect(poster(`${CDN}/p/intro.${extension}?v=2`), extension).toBeUndefined();
  });

  it("rejects a URL whose path does not end in the right extension, even when the query does", () => {
    expect(captions(`${CDN}/c/intro.txt`)).toMatch(/must end in \.vtt/);
    expect(captions(`${CDN}/c/intro?file=a.vtt`)).toMatch(/must end in \.vtt/);
    expect(captions(`${CDN}/c/intro.vtt/`)).toMatch(/must end in \.vtt/);
    expect(poster(`${CDN}/p/intro.mp4`)).toMatch(/must end in \.png, \.jpg, \.jpeg, \.webp, \.svg/);
    expect(poster(`${CDN}/p/intro?x=a.png`)).toMatch(/must end in \.png/);
  });

  it("rejects an embed origin, an unknown origin, http, a watch page, and credentials", () => {
    expect(captions("https://www.youtube-nocookie.com/embed/abc.vtt")).toMatch(/an embed player cannot serve a captions file/);
    expect(poster("https://player.vimeo.com/video/1.png")).toMatch(/an embed player cannot serve a poster image/);
    expect(captions("https://example.com/c.vtt")).toMatch(/is not in media-config\.json/);
    expect(poster("http://media.mcp-lab.example/p.png")).toMatch(/must start with https/);
    expect(poster("https://media.mcp-lab.example@evil.com/p.png")).toMatch(/credentials/);
    expect(captions("https://youtu.be/abc.vtt")).toMatch(/is not in media-config\.json|watch page/);
  });

  it("says a relative value is not an asset path or an https URL", () => {
    expect(captions("intro.vtt")).toMatch(/is not an asset path or an https URL/);
  });
});

describe("a config with other origins", () => {
  const other = loadMediaConfig(
    mediaConfigFile({
      mediaOrigins: ["https://cdn.example.test", "https://cdn2.example.test:8443"],
      embeds: [{ origin: "https://play.example.test", pathPrefix: "/e/", idPattern: "^[a-z]{3}$", watchHosts: ["watch.example.test"] }],
    }),
  );

  it("decides by that config alone", () => {
    expect(mediaUrlProblem("https://cdn.example.test/a.mp4", "video", other)).toBeUndefined();
    expect(mediaUrlProblem("https://cdn2.example.test:8443/a.mp4", "video", other)).toBeUndefined();
    expect(mediaUrlProblem("https://play.example.test/e/abc", "video", other)).toBeUndefined();
    expect(mediaUrlProblem(`${CDN}/a.mp4`, "video", other)).toMatch(/is not in media-config\.json/);
    expect(mediaUrlProblem("https://www.youtube-nocookie.com/embed/abc", "video", other)).toMatch(/is not in media-config\.json/);
  });

  it("builds the suggestions from the config", () => {
    expect(mediaUrlProblem("https://watch.example.test/x", "video", other)).toMatch(/use `https:\/\/play\.example\.test\/e\/<id>`/);
    expect(mediaUrlProblem("https://play.example.test/e/ABC", "video", other)).toMatch(/must be https:\/\/play\.example\.test\/e\/<id>, with an ID that matches \^\[a-z\]\{3\}\$/);
  });
});
