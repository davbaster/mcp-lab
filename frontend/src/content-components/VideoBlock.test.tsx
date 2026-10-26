import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { component, paragraph, renderTree, spyOnConsole, text } from "../test/renderTree";

const CDN = "https://media.mcp-lab.example/videos/intro.mp4";
const CAPTIONS_CDN = "https://media.mcp-lab.example/captions/intro.vtt";
const CAPTIONS_SITE = "/api/courses/c/assets/intro-a5e4372a760aafa6.vtt";
const POSTER_SITE = "/api/courses/c/assets/banner-9523775ba3da5de4.webp";
const YOUTUBE = "https://www.youtube-nocookie.com/embed/abc_DEF-123";
const VIMEO = "https://player.vimeo.com/video/76979871";

const video = (props: Record<string, unknown> = {}) => component("Video", { src: CDN, title: "Intro", ...props });

function player(container: HTMLElement): HTMLVideoElement {
  return container.querySelector("video") as HTMLVideoElement;
}

describe("Video, a file on a media origin", () => {
  it("renders a <video> with controls and preload=metadata, and no autoplay or loop", () => {
    const { container } = renderTree([video()]);
    const element = player(container);

    expect(element.getAttribute("src")).toBe(CDN);
    expect(element.hasAttribute("controls")).toBe(true);
    expect(element.getAttribute("preload")).toBe("metadata");
    expect(element.hasAttribute("autoplay")).toBe(false);
    expect(element.hasAttribute("loop")).toBe(false);
    expect(element.hasAttribute("poster")).toBe(false);
    expect(element.querySelector("track")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("uses a site path as the poster", () => {
    const { container } = renderTree([video({ poster: POSTER_SITE })]);
    expect(player(container).getAttribute("poster")).toBe(POSTER_SITE);
  });

  it("uses an https URL as the poster", () => {
    const { container } = renderTree([video({ poster: "https://media.mcp-lab.example/p.png" })]);
    expect(player(container).getAttribute("poster")).toBe("https://media.mcp-lab.example/p.png");
  });

  it("renders captions as an English track that is on by default", () => {
    const { container } = renderTree([video({ captions: CAPTIONS_SITE, poster: POSTER_SITE })]);
    const track = container.querySelector("video > track") as HTMLTrackElement;

    expect(track.getAttribute("kind")).toBe("captions");
    expect(track.getAttribute("srclang")).toBe("en");
    expect(track.getAttribute("label")).toBe("English");
    expect(track.hasAttribute("default")).toBe(true);
    expect(track.getAttribute("src")).toBe(CAPTIONS_SITE);
  });

  it("sets crossorigin=anonymous when the captions are on another origin", () => {
    const { container } = renderTree([video({ captions: CAPTIONS_CDN })]);
    expect(player(container).getAttribute("crossorigin")).toBe("anonymous");
    expect(container.querySelector("track")?.getAttribute("src")).toBe(CAPTIONS_CDN);
  });

  it("sets no crossorigin for captions on a site path, so a CDN without CORS headers still plays", () => {
    const { container } = renderTree([video({ captions: CAPTIONS_SITE })]);
    expect(player(container).hasAttribute("crossorigin")).toBe(false);
  });

  it("sets no crossorigin without captions, even with a poster on another origin", () => {
    const { container } = renderTree([video({ poster: "https://media.mcp-lab.example/p.png" })]);
    expect(player(container).hasAttribute("crossorigin")).toBe(false);
  });

  it("names the video for assistive technology from the title", () => {
    renderTree([video({ title: "Intro to MCP" })]);
    expect(screen.getByLabelText("Intro to MCP").tagName).toBe("VIDEO");
  });

  it("replaces the frame with a box when the video fails to load, and keeps the text around it", () => {
    const log = spyOnConsole();
    const { container } = renderTree([paragraph(text("Before")), video({ captions: CAPTIONS_SITE }), paragraph(text("After"))]);
    fireEvent.error(player(container));

    expect(container.querySelector("video")).toBeNull();
    expect(screen.getByText("This video could not be loaded.").className).toContain("media-fallback");
    expect(screen.getByText("Before")).toBeTruthy();
    expect(screen.getByText("After")).toBeTruthy();
    // A file that does not load is not a mistake in the lesson.
    expect(log.error).not.toHaveBeenCalled();
  });

  it("keeps the video when only the captions file fails to load", () => {
    const { container } = renderTree([video({ captions: CAPTIONS_CDN })]);
    fireEvent.error(container.querySelector("track") as Element);
    // An error event from a <track> does not bubble, but a bubbling one must not count either.
    fireEvent(container.querySelector("track") as Element, new Event("error", { bubbles: true }));

    expect(player(container)).toBeTruthy();
    expect(screen.queryByText("This video could not be loaded.")).toBeNull();
  });

  it("tries a new source after the old one failed", () => {
    const { container, rerenderTree } = renderTree([video()]);
    fireEvent.error(player(container));
    expect(screen.getByText("This video could not be loaded.")).toBeTruthy();

    rerenderTree([video({ src: "https://media.mcp-lab.example/videos/other.mp4" })]);
    expect(player(container).getAttribute("src")).toBe("https://media.mcp-lab.example/videos/other.mp4");
  });

  it("treats any other https URL as a file, never as an iframe", () => {
    const { container } = renderTree([
      video({ src: "https://evil.example/embed/abc" }),
      video({ src: "https://www.youtube-nocookie.com.evil.example/embed/abc" }),
      video({ src: "https://www.youtube.com/embed/abc" }),
      video({ src: "https://www.youtube-nocookie.com/watch?v=abc" }),
      video({ src: "https://www.youtube-nocookie.com:8443/embed/abc" }),
    ]);
    expect(container.querySelectorAll("iframe")).toHaveLength(0);
    expect(container.querySelectorAll("video")).toHaveLength(5);
  });
});

describe("Video, an embed", () => {
  it.each([
    ["YouTube", YOUTUBE],
    ["Vimeo", VIMEO],
  ])("renders a %s embed as an iframe with its four attributes", (_name, src) => {
    const { container } = renderTree([video({ src, title: "The embed" })]);
    const frame = container.querySelector("iframe") as HTMLIFrameElement;

    expect(frame.getAttribute("src")).toBe(src);
    expect(frame.getAttribute("title")).toBe("The embed");
    expect(frame.getAttribute("loading")).toBe("lazy");
    expect(frame.getAttribute("allow")).toBe("fullscreen; picture-in-picture; encrypted-media");
    expect(frame.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
    expect(container.querySelector("video")).toBeNull();
    expect(screen.getByTitle("The embed")).toBe(frame);
  });

  it.each(["allowfullscreen", "sandbox", "srcdoc", "autoplay", "allowfullscreen"])("does not set %s on the iframe", (attribute) => {
    const { container } = renderTree([video({ src: YOUTUBE })]);
    expect(container.querySelector("iframe")?.hasAttribute(attribute)).toBe(false);
  });

  it.each([
    ["?autoplay=1", YOUTUBE + "?autoplay=1", YOUTUBE],
    ["?autoplay=0", YOUTUBE + "?autoplay=0", YOUTUBE],
    ["a bare ?autoplay", YOUTUBE + "?autoplay", YOUTUBE],
    ["?AutoPlay=1", YOUTUBE + "?AutoPlay=1", YOUTUBE],
    ["?auto%70lay=1", YOUTUBE + "?auto%70lay=1", YOUTUBE],
    ["autoplay first", YOUTUBE + "?autoplay=1&start=30", YOUTUBE + "?start=30"],
    ["autoplay last", YOUTUBE + "?start=30&autoplay=1", YOUTUBE + "?start=30"],
    ["autoplay twice", VIMEO + "?autoplay=1&t=5s&autoplay=0", VIMEO + "?t=5s"],
  ])("removes autoplay from the iframe src (%s)", (_name, src, expected) => {
    const { container } = renderTree([video({ src })]);
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(expected);
  });

  it("keeps any other query, such as ?start=30, and the rest of the URL", () => {
    const { container } = renderTree([video({ src: YOUTUBE + "?start=30&rel=0" })]);
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(YOUTUBE + "?start=30&rel=0");
  });

  it("ignores captions and poster on an embed, with no error and no crossorigin", () => {
    const log = spyOnConsole();
    const { container } = renderTree([video({ src: YOUTUBE, captions: CAPTIONS_CDN, poster: POSTER_SITE })]);

    expect(container.querySelector("iframe")).toBeTruthy();
    expect(container.querySelector("track")).toBeNull();
    expect(container.querySelector("[poster]")).toBeNull();
    expect(container.querySelector("[crossorigin]")).toBeNull();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("still checks the captions of an embed: a bad captions value is a mistake in the lesson", () => {
    const log = spyOnConsole();
    renderTree([video({ src: YOUTUBE, captions: "http://media.mcp-lab.example/c.vtt" })]);
    expect(screen.getByText("This content can't be shown")).toBeTruthy();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});

describe("Video, both kinds", () => {
  it.each([
    ["an http src", { src: "http://media.mcp-lab.example/a.mp4" }, "src"],
    ["a javascript: src", { src: "javascript:alert(1)" }, "src"],
    ["a data: src", { src: "data:video/mp4;base64,AAAA" }, "src"],
    ["a protocol-relative src", { src: "//media.mcp-lab.example/a.mp4" }, "src"],
    ["a relative src", { src: "videos/a.mp4" }, "src"],
    ["a site path src", { src: "/api/courses/c/assets/a.mp4" }, "src"],
    ["a src with credentials", { src: "https://user:pw@media.mcp-lab.example/a.mp4" }, "src"],
    ["a src with a user name only", { src: "https://user@media.mcp-lab.example/a.mp4" }, "src"],
    ["a src with a space", { src: "https://media.mcp-lab.example/a b.mp4" }, "src"],
    ["a src with a backslash", { src: "https://media.mcp-lab.example\\a.mp4" }, "src"],
    ["a src with a tab", { src: "https://media.mcp-lab.example/\ta.mp4" }, "src"],
    ["no src", { src: undefined }, "src"],
    ["an empty src", { src: "" }, "src"],
    ["src as a bare attribute", { src: true }, "src"],
    ["no title", { title: undefined }, "title"],
    ["an empty title", { title: "" }, "title"],
    ["a blank title", { title: "   " }, "title"],
    ["title as a bare attribute", { title: true }, "title"],
    ["an http captions", { captions: "http://media.mcp-lab.example/c.vtt" }, "captions"],
    ["a relative captions", { captions: "c.vtt" }, "captions"],
    ["a javascript: captions", { captions: "javascript:alert(1)" }, "captions"],
    ["a protocol-relative captions", { captions: "//media.mcp-lab.example/c.vtt" }, "captions"],
    ["an empty captions", { captions: "" }, "captions"],
    ["an http poster", { poster: "http://media.mcp-lab.example/p.png" }, "poster"],
    ["a data: poster", { poster: "data:image/png;base64,AAAA" }, "poster"],
    ["a relative poster", { poster: "p.png" }, "poster"],
    ["an empty poster", { poster: "" }, "poster"],
  ])("shows the can't-be-shown box and logs once for %s", (_name, props, prop) => {
    const log = spyOnConsole();
    const { container } = renderTree([video(props)]);

    expect(container.querySelector("video, iframe, track")).toBeNull();
    expect(screen.getByText("This content can't be shown")).toBeTruthy();
    expect(log.error).toHaveBeenCalledTimes(1);
    const message = String(log.error.mock.calls[0][0]);
    expect(message).toContain("Video");
    expect(message).toContain(prop);
  });

  it("ignores props that are not in the schema", () => {
    const { container } = renderTree([video({ onload: "alert(1)", style: "x", autoplay: "true", loop: "true" })]);
    for (const attribute of ["onload", "style", "autoplay", "loop"]) expect(player(container).hasAttribute(attribute)).toBe(false);
  });

  it("puts the frame in a 16:9 box with the frame class that content.css sizes", () => {
    const { container } = renderTree([video(), video({ src: YOUTUBE })]);
    const frames = container.querySelectorAll(".video > .media-frame");
    expect(frames).toHaveLength(2);
    expect(frames[0].querySelector("video")).toBeTruthy();
    expect(frames[1].querySelector("iframe")).toBeTruthy();
  });

  it("works for several videos on one page, each with its own error state", () => {
    const { container } = renderTree([video({ title: "One" }), video({ title: "Two", src: "https://media.mcp-lab.example/two.mp4" })]);
    fireEvent.error(container.querySelectorAll("video")[0]);

    expect(container.querySelectorAll("video")).toHaveLength(1);
    expect(screen.getAllByText("This video could not be loaded.")).toHaveLength(1);
    expect(screen.getByLabelText("Two")).toBeTruthy();
  });
});
