// The exact problems of the invalid and warning fixtures for the asset rules (see fixtures.test.ts).
// A name or a symbolic link that cannot be committed on every platform (a device name, a trailing dot,
// two names that differ only in letter case, a link, a path over 100 characters, an oversized file) is
// tested with a temporary folder in asset-files.test.ts instead.

import type { Problem } from "../src/problem.ts";
import { error, lessonProblem, warning } from "./helpers.ts";

const HELLO = "chapters/01-intro/lessons/01-hello.mdx";
const ALLOWED = "the allowed types are .png, .jpg, .jpeg, .webp, .svg, .glb, .gltf, and .vtt";
const VIDEO_HINT = "videos are not kept in assets/: put them on the media CDN and use them with `Video`";
const NAME_RULE =
  "the name may use only letters, digits, `.`, `_`, and `-`, and may not start with `.`, so that a path never needs URL-encoding";
const notAllowed = (file: string, hint = "") => error(`assets/${file}`, `this file type is not allowed in assets/; ${ALLOWED}${hint}`);
const magic = (file: string, kind: string, extension: string) =>
  error(`assets/${file}`, `the file does not start like ${kind} file, so it is not one (for example, a video or a web page renamed to .${extension})`);
const outside = (key: string, uri: string) =>
  error("assets/models/box.gltf", `\`${key}[0]\` points to an outside file \`${uri}\`; embed it as a data: URI, or use a .glb file`);
const ref = (line: number, column: number, message: string) => lessonProblem(HELLO, line, column, message);
const imageSrc = (message: string, line = 8, column = 8) => ref(line, column, `the prop \`src\` of \`<Image>\`: ${message}`);
const videoSrc = (line: number, message: string) => ref(line, 8, `the prop \`src\` of \`<Video>\`: ${message}`);
const NOT_IN_CONFIG = (origin: string) => `the origin ${origin} is not in media-config.json; add it there (a reviewed change) or use an allowed origin`;
const EXTENSIONS_NEEDED = "one of .png, .jpg, .jpeg, .webp, .svg";

export const assetInvalid: Record<string, Problem[]> = {
  // the files in assets/
  "asset-type-not-allowed": [notAllowed("README.md"), notAllowed("docs/guide.md"), notAllowed("notes.txt")],
  "asset-video-file": [notAllowed("clips/intro.mp4", `; ${VIDEO_HINT}`), notAllowed("clips/outro.webm", `; ${VIDEO_HINT}`)],
  "asset-magic-mismatch": [
    magic("bad.glb", "a binary glTF", "glb"),
    magic("bad.jpeg", "a JPEG", "jpeg"),
    magic("bad.jpg", "a JPEG", "jpg"),
    magic("bad.png", "a PNG", "png"),
    magic("bad.webp", "a WebP", "webp"),
    magic("video.png", "a PNG", "png"),
  ],
  "asset-empty-file": [error("assets/images/empty.png", "the file is empty (0 bytes)")],
  "asset-name-characters": [
    ".hidden.png",
    "a#b.png",
    "a%b.png",
    "a&b.png",
    "a(b).png",
    "a+b.png",
    "a~b.png",
    "my folder",
    "my pic.png",
  ].map((name) => error(`assets/${name}`, NAME_RULE)),
  "asset-svg-rejected": [
    {
      severity: "error",
      file: "assets/images/bad.svg",
      line: 2,
      message: "the SVG has a `<script>` element, which can run code, load a page, or animate; remove it",
    },
  ],
  "asset-svg-not-utf8": [error("assets/images/utf16.svg", "the file is not valid UTF-8 text")],
  "asset-svg-nul": [
    { severity: "error", file: "assets/images/with-null-byte.svg", line: 1, message: "the SVG contains a NUL character, so it is not text" },
  ],
  "asset-vtt-no-header": [
    { severity: "error", file: "assets/captions/intro.vtt", line: 1, message: "a .vtt file must start with `WEBVTT` (after an optional byte order mark)" },
  ],
  "asset-vtt-not-utf8": [error("assets/captions/intro.vtt", "the file is not valid UTF-8 text")],
  "asset-gltf-not-json": [error("assets/models/box.gltf", "a .gltf file must be JSON text, but this is not valid JSON")],
  "asset-gltf-external-buffer": [outside("buffers", "box.bin")],
  "asset-gltf-external-image": [outside("images", "textures/wood.png")],

  // the references of a lesson (line and column of the prop or the Markdown image)
  "ref-missing-file": [imageSrc("there is no file `images/pic.png` in assets/")],
  "ref-case-differs": [imageSrc("there is no file `images/pic.png` in assets/; the file `images/Pic.png` exists, but names are case-sensitive")],
  "ref-wrong-type": [
    ref(16, 1, `the Markdown image: \`captions/intro.vtt\` is the wrong type; this prop needs ${EXTENSIONS_NEEDED}`),
    ref(14, 66, "the prop `captions` of `<Video>`: `images/pic.png` is the wrong type; this prop needs a .vtt file"),
    ref(8, 45, `the prop \`poster\` of \`<Model3D>\`: \`captions/intro.vtt\` is the wrong type; this prop needs ${EXTENSIONS_NEEDED}`),
    ref(14, 92, `the prop \`poster\` of \`<Video>\`: \`models/server.glb\` is the wrong type; this prop needs ${EXTENSIONS_NEEDED}`),
    ref(10, 10, "the prop `src` of `<Diagram>`: `images/pic.png` is the wrong type; this prop needs a .svg file"),
    imageSrc(`\`models/server.glb\` is the wrong type; this prop needs ${EXTENSIONS_NEEDED}`, 12),
    ref(8, 10, "the prop `src` of `<Model3D>`: `images/pic.png` is the wrong type; this prop needs one of .glb, .gltf"),
  ],
  "ref-folder": [imageSrc("`images` is a folder in assets/, not a file")],
  "ref-remote-asset": [
    ref(
      10,
      1,
      "the Markdown image: the file must be in assets/, not at the address `https://example.com/b.png` (the Content-Security-Policy would block it); write its path from assets/, as in `images/pic.png`",
    ),
    imageSrc(
      "the file must be in assets/, not at the address `https://example.com/a.png` (the Content-Security-Policy would block it); write its path from assets/, as in `images/pic.png`",
    ),
    ref(
      12,
      10,
      "the prop `src` of `<Model3D>`: the file must be in assets/, not at the address `mailto:a@example.com` (the Content-Security-Policy would block it); write its path from assets/, as in `images/pic.png`",
    ),
  ],
  "ref-path-escape": [imageSrc("the path has a `.` or `..` part; write the path from assets/ down, without leaving it")],
  "ref-video-origin": [
    videoSrc(8, `\`https://example.com/a.mp4\`: ${NOT_IN_CONFIG("https://example.com")}`),
    videoSrc(10, `\`https://media.mcp-lab.example.evil.com/a.mp4\`: ${NOT_IN_CONFIG("https://media.mcp-lab.example.evil.com")}`),
  ],
  "ref-video-relative": [
    videoSrc(8, "`clip.mp4` is not an absolute URL; videos are not served from assets/, so use a https URL on a media CDN or an embed URL"),
  ],
  "ref-video-watch-page": [
    videoSrc(10, "`https://vimeo.com/123` is a watch page, which cannot be embedded; use `https://player.vimeo.com/video/<id>`"),
    videoSrc(8, "`https://www.youtube.com/watch?v=abc` is a watch page, which cannot be embedded; use `https://www.youtube-nocookie.com/embed/<id>`"),
  ],
  "ref-video-embed-path": [
    videoSrc(
      8,
      "`https://www.youtube-nocookie.com/watch/abc`: an address on https://www.youtube-nocookie.com must be https://www.youtube-nocookie.com/embed/<id>, with an ID that matches ^[A-Za-z0-9_-]+$",
    ),
  ],
  "ref-video-captions-url": [
    ref(8, 66, "the prop `captions` of `<Video>`: `https://media.mcp-lab.example/c.txt`: the URL of a captions file must end in .vtt"),
    ref(8, 113, "the prop `poster` of `<Video>`: `https://media.mcp-lab.example/p.mp4`: the URL of a poster must end in .png, .jpg, .jpeg, .webp, .svg"),
  ],
  "ref-image-no-alt": [
    ref(10, 1, "`<Image>` is missing the required prop `alt`"),
    ref(8, 29, "the prop `alt` of `<Image>` must not be empty"),
  ],
  "ref-all-reported": [
    ...[
      [8, 8, "images/missing-one.png"],
      [10, 8, "images/missing-two.png"],
    ].map(([line, column, path]) => lessonProblem("chapters/01-intro/lessons/01-hello.mdx", Number(line), Number(column), `the prop \`src\` of \`<Image>\`: there is no file \`${path}\` in assets/`)),
    lessonProblem(
      "chapters/01-intro/lessons/02-again.mdx",
      8,
      1,
      "JavaScript expressions in curly braces are not allowed; to show a brace as text, write `\\{` or put it in a code span",
    ),
    lessonProblem("chapters/01-intro/lessons/03-third.mdx", 10, 1, "the Markdown image: there is no file `images/missing-four.png` in assets/"),
    lessonProblem(
      "chapters/01-intro/lessons/03-third.mdx",
      8,
      8,
      "the prop `src` of `<Video>`: `clip.mp4` is not an absolute URL; videos are not served from assets/, so use a https URL on a media CDN or an embed URL",
    ),
  ],
};

export const assetWarnings: Record<string, Problem[]> = {
  "asset-unused": [
    warning("assets/diagrams/unused.svg", "no lesson uses this file; use it in a lesson or remove it"),
    warning("assets/images/unused.png", "no lesson uses this file; use it in a lesson or remove it"),
  ],
};
