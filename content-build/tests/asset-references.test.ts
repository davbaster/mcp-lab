// The asset and media references of a lesson, checked through validateCourse: positions, messages, types, and URLs.

import { describe, expect, it } from "vitest";
import { validateCourse } from "../src/course.ts";
import { assetPathProblem } from "../src/references.ts";
import { GLB, GLTF, JPG, NEXT, PNG, SVG, VTT, WEBP, assetCourse, errorsOf, lessonWith } from "./asset-helpers.ts";
import { lessonProblem } from "./helpers.ts";

/** Every kind of file, so that a reference fails because of its type or its path and not because a file is missing. */
const ALL = {
  "images/pic.png": PNG,
  "images/photo.jpg": JPG,
  "images/banner.webp": WEBP,
  "images/logo.svg": SVG,
  "diagrams/flow.svg": SVG,
  "models/server.glb": GLB,
  "models/box.gltf": GLTF,
  "captions/intro.vtt": VTT,
};

/** The errors of the lesson `body` (it starts on line 8, column 1). Warnings are not looked at. */
function check(body: string, assets: Record<string, string | Uint8Array> = ALL) {
  return errorsOf(validateCourse(assetCourse(assets, lessonWith(body))));
}

const problem = (line: number, column: number, message: string) => lessonProblem(NEXT, line, column, message);
const image = (src: string) => `<Image src="${src}" alt="A picture" />`;

describe("a missing file", () => {
  it("is an error at the line and column of the prop, naming the component, the prop, and the path", () => {
    expect(check(image("images/missing.png"))).toEqual([
      problem(8, 8, "the prop `src` of `<Image>`: there is no file `images/missing.png` in assets/"),
    ]);
  });

  it("names each component and prop", () => {
    const body = [
      '<Diagram src="diagrams/none.svg" alt="A" />',
      '<Model3D src="models/none.glb" alt="A" poster="images/none.png" />',
      '<Video src="https://media.mcp-lab.example/a.mp4" title="A" captions="captions/none.vtt" poster="images/none.png" />',
      "![A](images/none.png)",
    ].join("\n\n");

    // The problems of a file come sorted by message.
    expect(check(body).map((p) => [p.line, p.column, p.message])).toEqual([
      [14, 1, "the Markdown image: there is no file `images/none.png` in assets/"],
      [12, 60, "the prop `captions` of `<Video>`: there is no file `captions/none.vtt` in assets/"],
      [10, 40, "the prop `poster` of `<Model3D>`: there is no file `images/none.png` in assets/"],
      [12, 89, "the prop `poster` of `<Video>`: there is no file `images/none.png` in assets/"],
      [8, 10, "the prop `src` of `<Diagram>`: there is no file `diagrams/none.svg` in assets/"],
      [10, 10, "the prop `src` of `<Model3D>`: there is no file `models/none.glb` in assets/"],
    ]);
  });

  it("looks the name up exactly: letter case matters, and the message says so", () => {
    const cases: [string, string][] = [
      ["images/PIC.png", "images/pic.png"],
      ["Images/pic.png", "images/pic.png"],
      ["images/pic.PNG", "images/pic.png"],
    ];
    for (const [value, existing] of cases) {
      expect(check(image(value))).toEqual([
        problem(8, 8, `the prop \`src\` of \`<Image>\`: there is no file \`${value}\` in assets/; the file \`${existing}\` exists, but names are case-sensitive`),
      ]);
    }
  });

  it("says nothing about letter case when no file differs only in case", () => {
    expect(check(image("images/other.png"))[0]?.message).not.toContain("case-sensitive");
  });

  it("does not find a file by a path that only some file systems accept", () => {
    expect(check(image("images/../images/pic.png"))).toHaveLength(1);
    expect(check(image("images/pic.png/"))).toHaveLength(1);
    expect(check(image("images/pic.png "))).toHaveLength(1);
  });
});

describe("the form of an asset path", () => {
  const cases: [string, string, RegExp][] = [
    ["starts with a slash", "/images/pic.png", /the path starts with a slash; write it relative to assets\//],
    ["starts with a backslash", "\\images\\pic.png", /the path starts with a slash/],
    ["has a backslash", "images\\pic.png", /the path has a backslash; separate folders with `\/`/],
    ["has a .. part", "../pic.png", /the path has a `\.` or `\.\.` part/],
    ["has a .. part in the middle", "images/../images/pic.png", /the path has a `\.` or `\.\.` part/],
    ["has a . part", "./images/pic.png", /the path has a `\.` or `\.\.` part/],
    ["has a . part in the middle", "images/./pic.png", /the path has a `\.` or `\.\.` part/],
    ["has an empty part", "images//pic.png", /the path has an empty part/],
    ["ends with a slash", "images/", /the path has an empty part/],
    ["has a percent sign", "images/a%20b.png", /the path has a `%`, `\?`, or `#`/],
    ["has a question mark", "images/pic.png?v=1", /the path has a `%`, `\?`, or `#`/],
    ["has a number sign", "images/pic.png#top", /the path has a `%`, `\?`, or `#`/],
    ["has a space", "images/my pic.png", /the path has a name with a character that file names in assets\/ may not have/],
    ["has a name that starts with a dot", "images/.hidden.png", /the path has a name with a character that file names in assets\/ may not have/],
    ["has a non-ASCII letter", "images/caf\u00e9.png", /the path has a name with a character that file names in assets\/ may not have/],
  ];

  it.each(cases)("rejects a path that %s, with its own message, at the prop", (_name, value, message) => {
    const problems = check(image(value));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ file: NEXT, line: 8, column: 8 });
    expect(problems[0]?.message).toMatch(message);
    expect(problems[0]?.message.startsWith("the prop `src` of `<Image>`: ")).toBe(true);
  });

  it("has its own message for each rule: slash, backslash, dot part, empty part, %?#, and a bad name", () => {
    const messages = cases.map(([, value]) => assetPathProblem(value));

    expect(messages.every((message) => message !== undefined)).toBe(true);
    expect(new Set(messages).size).toBe(6);
    expect(assetPathProblem("")).toBe("the path is empty");
    expect(assetPathProblem("images/pic.png")).toBeUndefined();
  });

  it("rejects an empty path in a Markdown image, where #8 has no rule for it", () => {
    expect(check("![A picture]()")).toEqual([problem(8, 1, "the Markdown image: the path is empty")]);
  });

  it("leaves an empty src prop and a drive path to #8, which rejects them before the references are looked at", () => {
    expect(check('<Image src="" alt="A" />').map((p) => p.message)).toEqual(["the prop `src` of `<Image>` must not be empty"]);
    expect(check('<Image src="C:\\x.png" alt="A" />').map((p) => p.message)).toEqual([
      "the prop `src` of `<Image>`: the URL scheme `C:` is not allowed; use http, https, mailto, or a relative URL",
    ]);
  });

  it("reports a path to a folder", () => {
    expect(check(image("images"))).toEqual([problem(8, 8, "the prop `src` of `<Image>`: `images` is a folder in assets/, not a file")]);
    expect(check(image("diagrams"), { "diagrams/flow.svg": SVG })).toHaveLength(1);
  });

  it("accepts the paths that the name rule allows", () => {
    const assets = { "a/b_c/d-e.f.png": PNG, "_x.png": PNG, "1.png": PNG };

    expect(check(`${image("a/b_c/d-e.f.png")}\n\n${image("_x.png")}\n\n${image("1.png")}`, assets)).toEqual([]);
  });
});

describe("the type of the file must fit the use", () => {
  const IMAGES = ["images/pic.png", "images/photo.jpg", "images/banner.webp", "images/logo.svg"];

  it.each(IMAGES)("accepts %s as Image.src, as a Markdown image, as a Model3D poster, and as a Video poster", (path) => {
    const body = [
      image(path),
      `![A picture](${path})`,
      `<Model3D src="models/server.glb" alt="A" poster="${path}" />`,
      `<Video src="https://media.mcp-lab.example/a.mp4" title="A" poster="${path}" />`,
    ].join("\n\n");

    expect(check(body)).toEqual([]);
  });

  it.each(["models/server.glb", "models/box.gltf", "captions/intro.vtt"])("rejects %s where an image is needed, naming the types", (path) => {
    const needs = "one of .png, .jpg, .jpeg, .webp, .svg";
    const body = [
      image(path),
      `![A picture](${path})`,
      `<Model3D src="models/server.glb" alt="A" poster="${path}" />`,
      `<Video src="https://media.mcp-lab.example/a.mp4" title="A" poster="${path}" />`,
    ].join("\n\n");

    // The problems of a file come sorted by message.
    expect(check(body).map((p) => p.message)).toEqual([
      `the Markdown image: \`${path}\` is the wrong type; this prop needs ${needs}`,
      `the prop \`poster\` of \`<Model3D>\`: \`${path}\` is the wrong type; this prop needs ${needs}`,
      `the prop \`poster\` of \`<Video>\`: \`${path}\` is the wrong type; this prop needs ${needs}`,
      `the prop \`src\` of \`<Image>\`: \`${path}\` is the wrong type; this prop needs ${needs}`,
    ]);
  });

  it("needs .glb or .gltf for Model3D.src", () => {
    expect(check('<Model3D src="models/server.glb" alt="A" poster="images/pic.png" />\n\n<Model3D src="models/box.gltf" alt="A" poster="images/pic.png" />')).toEqual([]);
    expect(check('<Model3D src="images/pic.png" alt="A" poster="images/pic.png" />').map((p) => p.message)).toEqual([
      "the prop `src` of `<Model3D>`: `images/pic.png` is the wrong type; this prop needs one of .glb, .gltf",
    ]);
  });

  it("needs .svg for Diagram.src: not even a PNG", () => {
    expect(check('<Diagram src="diagrams/flow.svg" alt="A" />')).toEqual([]);
    expect(check('<Diagram src="images/pic.png" alt="A" />').map((p) => p.message)).toEqual([
      "the prop `src` of `<Diagram>`: `images/pic.png` is the wrong type; this prop needs a .svg file",
    ]);
  });

  it("needs .vtt for Video.captions", () => {
    expect(check('<Video src="https://media.mcp-lab.example/a.mp4" title="A" captions="captions/intro.vtt" />')).toEqual([]);
    expect(check('<Video src="https://media.mcp-lab.example/a.mp4" title="A" captions="images/pic.png" />').map((p) => p.message)).toEqual([
      "the prop `captions` of `<Video>`: `images/pic.png` is the wrong type; this prop needs a .vtt file",
    ]);
  });

  it("compares the extension without regard to letter case", () => {
    expect(check(image("images/UP.PNG"), { "images/UP.PNG": PNG })).toEqual([]);
  });
});

describe("a URL where a file in assets/ is needed", () => {
  const props: [string, (value: string) => string][] = [
    ["Image.src", (v) => image(v)],
    ["Diagram.src", (v) => `<Diagram src="${v}" alt="A" />`],
    ["Model3D.src", (v) => `<Model3D src="${v}" alt="A" poster="images/pic.png" />`],
    ["Model3D.poster", (v) => `<Model3D src="models/server.glb" alt="A" poster="${v}" />`],
    ["a Markdown image", (v) => `![A](${v})`],
  ];

  it.each(props)("rejects an http, https, or mailto value in %s", (_name, write) => {
    for (const value of ["https://example.com/a.png", "http://example.com/a.png", "https://media.mcp-lab.example/a.png", "mailto:a@example.com", "HTTPS://EXAMPLE.COM/a.png"]) {
      const problems = check(write(value));

      expect(problems, value).toHaveLength(1);
      expect(problems[0]?.message, value).toContain(`the file must be in assets/, not at the address \`${value}\` (the Content-Security-Policy would block it)`);
    }
  });

  it("is not an error for a Markdown link, which is not an asset reference", () => {
    expect(check("[a page](https://example.com/) and [a file](images/not-there.png) and [mail](mailto:a@example.com)")).toEqual([]);
  });
});

describe("Video", () => {
  const video = (attributes: string) => `<Video title="A video" ${attributes} />`;

  it("takes the src as a URL and never as a file in assets/", () => {
    expect(check(video('src="https://media.mcp-lab.example/a.mp4"'))).toEqual([]);
    expect(check(video('src="images/pic.png"')).map((p) => p.message)).toEqual([
      expect.stringContaining("not an absolute URL; videos are not served from assets/"),
    ]);
  });

  it("accepts an allowlisted URL, an asset path, or nothing for captions and poster", () => {
    expect(check(video('src="https://media.mcp-lab.example/a.mp4" captions="https://media.mcp-lab.example/c.vtt" poster="https://media.mcp-lab.example/p.png"'))).toEqual([]);
    expect(check(video('src="https://media.mcp-lab.example/a.mp4" captions="captions/intro.vtt" poster="images/pic.png"'))).toEqual([]);
    expect(check(video('src="https://www.youtube-nocookie.com/embed/abc"'))).toEqual([]);
  });

  it("rejects a captions or poster URL on another origin, on an embed origin, or with the wrong file name", () => {
    const body = video(
      'src="https://media.mcp-lab.example/a.mp4" captions="https://example.com/c.vtt" poster="https://www.youtube-nocookie.com/embed/p"',
    );

    expect(check(body).map((p) => p.message)).toEqual([
      expect.stringContaining("the prop `captions` of `<Video>`: `https://example.com/c.vtt`: the origin https://example.com is not in media-config.json"),
      expect.stringContaining("the prop `poster` of `<Video>`: `https://www.youtube-nocookie.com/embed/p`: an embed player cannot serve a poster image"),
    ]);
    expect(check(video('src="https://media.mcp-lab.example/a.mp4" captions="https://media.mcp-lab.example/c.txt"'))).toHaveLength(1);
  });

  it("puts the problem of the src at the src, with the URL in the message", () => {
    expect(check(video('src="https://evil.example/a.mp4"'))).toEqual([
      problem(8, 24, "the prop `src` of `<Video>`: `https://evil.example/a.mp4`: the origin https://evil.example is not in media-config.json; add it there (a reviewed change) or use an allowed origin"),
    ]);
  });
});

describe("Image and Diagram", () => {
  it("fails the build for an Image with an empty or missing alt, at the tag or the prop (the #8 rule)", () => {
    expect(check('<Image src="images/pic.png" alt="" />\n\n<Image src="images/pic.png" />').map((p) => [p.line, p.column, p.message])).toEqual([
      [10, 1, "`<Image>` is missing the required prop `alt`"],
      [8, 29, "the prop `alt` of `<Image>` must not be empty"],
    ]);
  });

  it("allows a Markdown image with an empty alt", () => {
    expect(check("![](images/pic.png)")).toEqual([]);
  });

  it("gives no check to a Diagram with source (Mermaid), which is not a file", () => {
    expect(check('<Diagram alt="Flow" source="graph TD; A-->B" />')).toEqual([]);
  });

  it("checks a Diagram with an .svg src as an Image, and the SVG rules on the file once", () => {
    const bad = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const course = assetCourse({ "diagrams/bad.svg": bad }, lessonWith('<Diagram src="diagrams/bad.svg" alt="A" />\n\n<Image src="diagrams/bad.svg" alt="A" />'));

    expect(errorsOf(validateCourse(course)).map((p) => [p.file, p.line])).toEqual([["assets/diagrams/bad.svg", 1]]);
  });
});

describe("the problems of all references", () => {
  it("are all found in one run, in lesson order, together with the lesson's own problems", () => {
    const body = [
      image("images/one.png"),
      "{1 + 1}",
      image("images/two.png"),
    ].join("\n\n");
    const problems = check(body);

    // The lesson has its own problem, so its references are not known: only that problem is reported.
    expect(problems.map((p) => p.message)).toEqual([expect.stringContaining("JavaScript expressions in curly braces")]);
  });

  it("finds every bad reference of a lesson at once, and one bad reference does not hide another", () => {
    const body = [image("images/one.png"), image("../two.png"), "![A](images/three.png)", '<Video title="V" src="clip.mp4" />'].join("\n\n");

    expect(check(body).map((p) => [p.line, p.column])).toEqual([
      [12, 1],
      [10, 8],
      [8, 8],
      [14, 18],
    ]);
  });

  it("reports the references of every lesson of every chapter", () => {
    const first = "chapters/01-first-steps/lessons/01-welcome.mdx";
    const course = assetCourse({}, lessonWith(image("images/b.png")), { [first]: lessonWith(image("images/a.png")) });

    expect(errorsOf(validateCourse(course)).map((p) => p.file)).toEqual([first, NEXT]);
  });
});
