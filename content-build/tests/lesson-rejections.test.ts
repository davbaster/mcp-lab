// Every rejection: one fixture per case under fixtures/lessons/invalid/, and the exact file, line, column, and message.
// The rules run against the small schema folder in fixtures/components/, so they do not change when a real schema does.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileLesson } from "../src/lesson.ts";
import type { Problem } from "../src/problem.ts";
import { COMPONENT_FIXTURES, LESSON_FIXTURES, lessonProblem } from "./helpers.ts";

const NO_FRONT_MATTER = "the lesson must start with a front-matter block: a `---` line, the settings, and a closing `---` line";
const EXPRESSION =
  "JavaScript expressions in curly braces are not allowed; to show a brace as text, write `\\{` or put it in a code span";
const ESM = "`import` and `export` statements are not allowed in a lesson";
const SCRIPT = "`<script>` is not allowed in a lesson";
const ELEMENTS = "`Callout`, `Diagram`, `Flag`, `Image`, `Step`, `Tabs`, `Video`";
const unknownComponent = (name: string) => `unknown component \`${name}\`; the components are ${ELEMENTS}`;
const html = (name: string) => `the HTML element \`<${name}>\` is not allowed; use Markdown or one of the components`;
const handler = (name: string) => `the event-handler attribute \`${name}\` is not allowed; no attribute whose name starts with \`on\` is`;
const propExpression = (name: string) =>
  `the value of the prop \`${name}\` is a JavaScript expression, which is not allowed; write a string, as in ${name}="..."`;
const scheme = (name: string) => `the URL scheme \`${name}:\` is not allowed; use http, https, mailto, or a relative URL`;
const unknownProp = (component: string, prop: string, props: string) =>
  `\`<${component}>\` has an unknown prop \`${prop}\`; its props are ${props}`;
const REFERENCE_DEFINITION = "link reference definitions (`[label]: url`) are not supported; write the URL in the link itself";

const at = (name: string, line: number, column: number, message: string): Problem =>
  lessonProblem(`lessons/${name}.mdx`, line, column, message);

/** The expected problems of each fixture in fixtures/lessons/invalid/ (every lesson there starts its body on line 6). */
const INVALID: Record<string, Problem[]> = {
  // JavaScript expressions
  "expression-flow": [at("expression-flow", 6, 1, EXPRESSION)],
  "expression-text": [at("expression-text", 6, 15, EXPRESSION)],
  "expression-comment": [at("expression-comment", 6, 1, EXPRESSION)],
  "expression-prop-object": [at("expression-prop-object", 6, 28, propExpression("style"))],
  "expression-prop-number": [at("expression-prop-number", 6, 28, propExpression("width"))],
  "expression-prop-spread": [
    at("expression-prop-spread", 6, 28, "a spread attribute `{...}` is not allowed; write each prop as a plain string"),
  ],
  // import and export
  "import-statement": [at("import-statement", 6, 1, ESM)],
  "export-statement": [at("export-statement", 6, 1, ESM)],
  // HTML elements, fragments, names
  "script-element": [at("script-element", 6, 1, SCRIPT)],
  "html-div": [at("html-div", 6, 1, html("div"))],
  "html-iframe": [at("html-iframe", 6, 1, html("iframe"))],
  "html-inline": [at("html-inline", 6, 3, html("span"))],
  fragment: [at("fragment", 6, 1, "a fragment (`<>`) is not allowed; use a component or plain Markdown")],
  "name-namespaced": [
    at("name-namespaced", 6, 1, "the name `<a:b>` is not allowed; a component name is one plain word, such as `Callout`"),
  ],
  "name-member": [
    at("name-member", 6, 1, "the name `<a.b>` is not allowed; a component name is one plain word, such as `Callout`"),
  ],
  // event handlers
  "handler-component": [at("handler-component", 6, 21, handler("onClick"))],
  "handler-html": [at("handler-html", 6, 1, html("div")), at("handler-html", 6, 6, handler("onClick"))],
  "handler-uppercase": [at("handler-uppercase", 6, 21, handler("ONCLICK"))],
  // components that are not in the schema folder
  "component-unknown": [at("component-unknown", 6, 1, unknownComponent("Iframe"))],
  "component-wrong-case": [at("component-wrong-case", 6, 1, unknownComponent("CALLOUT"))],
  "component-proto": [at("component-proto", 6, 1, unknownComponent("__proto__"))],
  "component-tab-outside-tabs": [at("component-tab-outside-tabs", 6, 1, unknownComponent("Tab"))],
  // props
  "prop-unknown": [at("prop-unknown", 6, 28, unknownProp("Image", "size", "`src`, `alt`"))],
  "prop-unknown-proto": [
    at("prop-unknown-proto", 6, 28, unknownProp("Image", "__proto__", "`src`, `alt`")),
    at("prop-unknown-proto", 6, 42, unknownProp("Image", "constructor", "`src`, `alt`")),
  ],
  "prop-duplicate": [at("prop-duplicate", 6, 28, "the prop `alt` of `<Image>` is written more than once")],
  "prop-bare-on-string": [at("prop-bare-on-string", 6, 8, 'the prop `src` of `<Image>` needs a value, as in src="..."')],
  "prop-value-on-boolean": [
    at("prop-value-on-boolean", 6, 7, "the prop `flag` of `<Flag>` is a bare attribute and takes no value; write just `flag`"),
  ],
  "prop-enum": [at("prop-enum", 6, 10, "the prop `type` of `<Callout>` must be one of `tip`, `warning`, `note`")],
  "prop-pattern": [at("prop-pattern", 6, 7, "the prop `step` of `<Step>` must match the pattern `^[1-9][0-9]*$`")],
  "prop-required-missing": [at("prop-required-missing", 6, 1, "`<Image>` is missing the required prop `src`")],
  "prop-required-empty": [at("prop-required-empty", 6, 20, "the prop `alt` of `<Image>` must not be empty")],
  "prop-oneof-both": [at("prop-oneof-both", 6, 1, "`<Diagram>` needs exactly one of `src` or `source`, but it has both")],
  "prop-oneof-neither": [at("prop-oneof-neither", 6, 1, "`<Diagram>` needs exactly one of `src` or `source`, but it has neither")],
  // children
  "children-none": [
    at("children-none", 8, 1, "`<Video>` takes no children; write it as <Video ... /> or put nothing between the tags"),
  ],
  "children-tabs-markdown": [at("children-tabs-markdown", 8, 1, "`<Tabs>` can contain only `<Tab>`, not Markdown")],
  "children-tabs-component": [
    at("children-tabs-component", 8, 1, "`<Tabs>` cannot contain `<Callout>`; it can contain only `<Tab>`"),
  ],
  "children-tabs-too-few": [at("children-tabs-too-few", 6, 1, "`<Tabs>` needs at least 2 `<Tab>` elements but has 1")],
  "children-tab-label-missing": [at("children-tab-label-missing", 8, 1, "`<Tab>` is missing the required prop `label`")],
  // URLs
  "url-link-javascript": [at("url-link-javascript", 6, 1, `link: ${scheme("javascript")}`)],
  "url-image-data": [at("url-image-data", 6, 1, `image: ${scheme("data")}`)],
  "url-link-uppercase-space": [at("url-link-uppercase-space", 6, 1, `link: ${scheme("JavaScript")}`)],
  "url-protocol-relative": [
    at(
      "url-protocol-relative",
      6,
      1,
      "link: a URL that starts with `//` is not allowed; write the whole http or https address, or a path that starts with one `/`",
    ),
  ],
  "url-prop-file": [at("url-prop-file", 6, 8, `the prop \`src\` of \`<Image>\`: ${scheme("file")}`)],
  // parse errors: the position and the message are the parser's
  "parse-unclosed-tag": [at("parse-unclosed-tag", 6, 1, "Expected a closing tag for `<Callout>` (6:1-6:21)")],
  "parse-mismatched-closing-tag": [
    at(
      "parse-mismatched-closing-tag",
      10,
      1,
      "Unexpected closing tag `</Tabs>`, expected corresponding closing tag for `<Callout>` (6:1-6:21)",
    ),
  ],
  "parse-bad-expression": [at("parse-bad-expression", 6, 5, "Could not parse expression with acorn")],
  "parse-bad-tag": [
    at(
      "parse-bad-tag",
      6,
      28,
      "Unexpected end of file in attribute name, expected an attribute name character such as letters, digits, `$`, or `_`; `=` to initialize a value; whitespace before attributes; or the end of the tag",
    ),
  ],
  // components are block-level only
  "inline-component": [
    at(
      "inline-component",
      6,
      1,
      "`<Callout>` is inside a paragraph; put the opening and closing tags on their own lines, with a blank line before and after the content",
    ),
  ],
  // Markdown that is not supported
  "unsupported-reference-link": [
    at("unsupported-reference-link", 6, 1, "reference-style links are not supported; write the link as [text](url)"),
    at("unsupported-reference-link", 8, 1, REFERENCE_DEFINITION),
  ],
  "unsupported-reference-image": [
    at("unsupported-reference-image", 6, 1, "reference-style images are not supported; write the image as ![alt](url)"),
    at("unsupported-reference-image", 8, 1, REFERENCE_DEFINITION),
  ],
  "unsupported-definition": [at("unsupported-definition", 6, 1, REFERENCE_DEFINITION)],
  "unsupported-code-meta": [
    at(
      "unsupported-code-meta",
      6,
      1,
      "a code fence can have only a language after the opening fence; remove the text after the language",
    ),
  ],
  // the front matter block (the same messages as the course check)
  "front-matter-missing": [lessonProblem("lessons/front-matter-missing.mdx", 1, 1, NO_FRONT_MATTER)],
  "front-matter-unclosed": [
    lessonProblem("lessons/front-matter-unclosed.mdx", 1, 1, "the front matter that starts here has no closing `---` line"),
  ],
  // more than one problem in a lesson
  "several-problems": [
    at("several-problems", 6, 11, EXPRESSION),
    at("several-problems", 8, 1, ESM),
    at("several-problems", 10, 1, SCRIPT),
    at("several-problems", 12, 1, unknownComponent("Iframe")),
    at("several-problems", 14, 1, `link: ${scheme("javascript")}`),
  ],
};

function compileFixture(name: string, text?: string) {
  const source = text ?? readFileSync(join(LESSON_FIXTURES, "invalid", `${name}.mdx`), "utf8");
  return compileLesson(source, { path: `lessons/${name}.mdx`, schemaDir: COMPONENT_FIXTURES });
}

describe("rejected lessons", () => {
  it.each(Object.entries(INVALID))("%s", (name, expected) => {
    expect(compileFixture(name)).toEqual({ problems: expected });
  });

  it("has an expected list for every fixture and a fixture for every list", () => {
    const fixtures = readdirSync(join(LESSON_FIXTURES, "invalid"))
      .map((file) => file.replace(/\.mdx$/, ""))
      .sort();

    expect(fixtures).toEqual(Object.keys(INVALID).sort());
  });

  it("gives every rejection a file, a line, and a column", () => {
    for (const [name, problems] of Object.entries(INVALID)) {
      for (const problem of problems) {
        expect(problem.file, name).toBe(`lessons/${name}.mdx`);
        expect(problem.severity, name).toBe("error");
        expect(problem.line, name).toBeGreaterThanOrEqual(1);
        expect(problem.column, name).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("returns the problems or the tree, never both and never a thrown lesson error", () => {
    for (const name of Object.keys(INVALID)) {
      const result = compileFixture(name);
      expect("problems" in result, name).toBe(true);
      expect("tree" in result, name).toBe(false);
    }
  });

  it("reports the same positions and messages when the file has CRLF endings and a byte order mark", () => {
    for (const name of Object.keys(INVALID)) {
      const text = readFileSync(join(LESSON_FIXTURES, "invalid", `${name}.mdx`), "utf8");

      expect(compileFixture(name, `\uFEFF${text.replaceAll("\n", "\r\n")}`), name).toEqual({ problems: INVALID[name] });
    }
  });

  it("reports the problems in the order of the lesson", () => {
    const result = compileFixture("several-problems");
    const positions = "problems" in result ? result.problems.map((p) => [p.line, p.column]) : [];

    expect(positions).toEqual([...positions].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0)));
  });
});

describe("the file name in a problem", () => {
  it("is the path as given, written with /", () => {
    const text = "---\ntitle: T\norder: 1\n---\n\n{1}\n";

    expect(compileLesson(text, { path: "chapters\\01-a\\lessons\\01-b.mdx", schemaDir: COMPONENT_FIXTURES })).toEqual({
      problems: [lessonProblem("chapters/01-a/lessons/01-b.mdx", 6, 1, EXPRESSION)],
    });
  });
});

describe("a parse error", () => {
  it("stops the lesson at the parser's error, even when the rest has more problems", () => {
    const result = compileFixture("x", "---\ntitle: T\norder: 1\n---\n\n{1 + 1}\n\n<Callout>\n\nnever closed\n\n<script />\n\n[x](javascript:1)\n");

    expect(result).toEqual({ problems: [lessonProblem("lessons/x.mdx", 8, 1, "Expected a closing tag for `<Callout>` (8:1-8:10)")] });
  });
});

describe("the names of components and props", () => {
  it("compares names exactly, even where the file system ignores case", () => {
    for (const name of ["CALLOUT", "CallOut", "Callouts", "Calloutt"]) {
      const result = compileFixture("x", `---\ntitle: T\norder: 1\n---\n\n<${name} type="tip" />\n`);

      expect("problems" in result && result.problems.map((p) => p.message), name).toEqual([unknownComponent(name)]);
    }
  });

  it("reads a name that starts with a lowercase letter as an HTML element, whatever it spells", () => {
    const result = compileFixture("x", '---\ntitle: T\norder: 1\n---\n\n<callout type="tip" />\n');

    expect("problems" in result && result.problems.map((p) => p.message)).toEqual([html("callout")]);
  });

  it("says an unknown element inside Tabs is unknown, and does not also say Tabs cannot hold it", () => {
    const tab = (label: string) => `<Tab label="${label}">\n\ntext\n\n</Tab>`;
    const result = compileFixture("x", `---\ntitle: T\norder: 1\n---\n\n<Tabs>\n\n${tab("One")}\n\n<Iframe />\n\n<div />\n\n${tab("Two")}\n\n</Tabs>\n`);

    expect("problems" in result && result.problems.map((p) => [p.line, p.message])).toEqual([
      [14, `${unknownComponent("Iframe").replace("the components are ", "the components are `Tab`, ")}`],
      [16, html("div")],
    ]);
  });

  it("rejects __proto__, constructor, and similar names as unknown and changes nothing else", () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    const source = [
      "---\ntitle: T\norder: 1\n---\n",
      '<Image src="a.png" alt="A" __proto__="x" constructor="y" hasOwnProperty="z" toString="w" />',
      "<__proto__ />",
      "<Constructor />",
      '<Callout type="tip" __proto__="polluted" />',
    ].join("\n\n");

    const result = compileFixture("x", `${source}\n`);

    expect("problems" in result && result.problems.map((p) => p.message)).toEqual([
      unknownProp("Image", "__proto__", "`src`, `alt`"),
      unknownProp("Image", "constructor", "`src`, `alt`"),
      unknownProp("Image", "hasOwnProperty", "`src`, `alt`"),
      unknownProp("Image", "toString", "`src`, `alt`"),
      unknownComponent("__proto__"),
      unknownComponent("Constructor"),
      unknownProp("Callout", "__proto__", "`type`, `title`"),
    ]);
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe("event-handler attributes", () => {
  it.each(["onClick", "onclick", "ONCLICK", "onMouseOver", "on", "onx", "once"])("rejects %s on a component and on an element", (name) => {
    const onComponent = compileFixture("x", `---\ntitle: T\norder: 1\n---\n\n<Callout type="tip" ${name}="x" />\n`);
    const onElement = compileFixture("x", `---\ntitle: T\norder: 1\n---\n\n<p ${name}="x" />\n`);

    expect(onComponent).toEqual({ problems: [lessonProblem("lessons/x.mdx", 6, 21, handler(name))] });
    expect(onElement).toEqual({ problems: [html("p"), handler(name)].map((message, i) => lessonProblem("lessons/x.mdx", 6, i === 0 ? 1 : 4, message)) });
  });

  it("rejects a handler written with an expression as a handler, naming the attribute", () => {
    const result = compileFixture("x", '---\ntitle: T\norder: 1\n---\n\n<Callout type="tip" onClick={() => alert(1)} />\n');

    expect(result).toEqual({ problems: [lessonProblem("lessons/x.mdx", 6, 21, handler("onClick"))] });
  });

  it("does not also check the props of an element whose attribute holds code, since they cannot be known", () => {
    const messages = (body: string) => {
      const result = compileFixture("x", `---\ntitle: T\norder: 1\n---\n\n${body}\n`);
      return "problems" in result ? result.problems.map((p) => p.message) : [];
    };

    expect(messages('<Image src={url} alt="A" />')).toEqual([propExpression("src")]);
    expect(messages("<Image {...props} />")).toEqual(["a spread attribute `{...}` is not allowed; write each prop as a plain string"]);
    expect(messages('<Callout {...props} type="danger" />')).toEqual([
      "a spread attribute `{...}` is not allowed; write each prop as a plain string",
    ]);
  });

  it("accepts a prop whose name only contains on", () => {
    const result = compileFixture("x", '---\ntitle: T\norder: 1\n---\n\n<Flag name="x" />\n<Image src="a.png" alt="b" />\n');

    expect("tree" in result).toBe(true);
  });
});

describe("URLs", () => {
  const source = (body: string) => `---\ntitle: T\norder: 1\n---\n\n${body}\n`;
  const messages = (body: string) => {
    const result = compileFixture("x", source(body));
    return "problems" in result ? result.problems.map((p) => p.message) : [];
  };

  it.each([
    ["javascript:alert(1)", "javascript"],
    ["JAVASCRIPT:alert(1)", "JAVASCRIPT"],
    ["data:text/html;base64,AAAA", "data"],
    ["vbscript:msgbox(1)", "vbscript"],
    ["file:///etc/passwd", "file"],
    ["ftp://example.com/x", "ftp"],
  ])("rejects the link %s", (url, name) => {
    expect(messages(`[x](${url})`)).toEqual([`link: ${scheme(name)}`]);
    expect(messages(`![x](${url})`)).toEqual([`image: ${scheme(name)}`]);
    expect(messages(`<Image src="${url}" alt="x" />`)).toEqual([`the prop \`src\` of \`<Image>\`: ${scheme(name)}`]);
    expect(messages(`<Video src="a.mp4" title="x" />\n\n<Diagram alt="x" src="${url}" />`)).toEqual([
      `the prop \`src\` of \`<Diagram>\`: ${scheme(name)}`,
    ]);
  });

  it("rejects a scheme with a space, a control character, or a tab in front of it or inside it", () => {
    expect(messages("[x](< javascript:alert(1)>)")).toEqual([`link: ${scheme("javascript")}`]);
    expect(messages("[x](<\tjavascript:alert(1)>)")).toEqual([`link: ${scheme("javascript")}`]);
    expect(messages("[x](<\u0001javascript:alert(1)>)")).toEqual([`link: ${scheme("javascript")}`]);
    expect(messages("[x](<\u000bJaVaScRiPt:alert(1)>)")).toEqual([`link: ${scheme("JaVaScRiPt")}`]);
    expect(messages("[x](&#32;javascript:alert(1))")).toEqual([`link: ${scheme("javascript")}`]);
    expect(messages("[x](&#9;javascript:alert(1))")).toEqual([`link: ${scheme("javascript")}`]);
    expect(messages("[x](java&#9;script:alert(1))")).toEqual([`link: ${scheme("javascript")}`]);
    expect(messages("[x](java&#10;script:alert(1))")).toEqual([`link: ${scheme("javascript")}`]);
    expect(messages("[x](&#106;avascript:alert(1))")).toEqual([`link: ${scheme("javascript")}`]);
    expect(messages('<Image src=" javascript:alert(1)" alt="x" />')).toEqual([`the prop \`src\` of \`<Image>\`: ${scheme("javascript")}`]);
    expect(messages('<Image src="\u0001data:text/html,x" alt="x" />')).toEqual([`the prop \`src\` of \`<Image>\`: ${scheme("data")}`]);
    expect(messages('<Image src="&#32;data:text/html,x" alt="x" />')).toEqual([`the prop \`src\` of \`<Image>\`: ${scheme("data")}`]);
  });

  it("rejects a URL that starts with //", () => {
    const rule = "a URL that starts with `//` is not allowed; write the whole http or https address, or a path that starts with one `/`";

    expect(messages("[x](//evil.example/a)")).toEqual([`link: ${rule}`]);
    expect(messages("![x](//evil.example/a.png)")).toEqual([`image: ${rule}`]);
    expect(messages('<Image src="//evil.example/a.png" alt="x" />')).toEqual([`the prop \`src\` of \`<Image>\`: ${rule}`]);
  });

  it.each(["../a.md", "/x", "#section", "?q=1", "a.md", "http://example.com/a", "https://example.com/a", "mailto:a@example.com", "HTTPS://EXAMPLE.COM"])(
    "accepts the URL %s in a link, an image, and a URL prop",
    (url) => {
      const result = compileFixture("x", source(`[x](${url})\n\n![x](${url})\n\n<Image src="${url}" alt="x" />`));

      expect("tree" in result, url).toBe(true);
    },
  );

  it("does not check the scheme of a prop that is not a URL", () => {
    const result = compileFixture("x", source('<Callout type="tip" title="javascript:alert(1)" />'));

    expect("tree" in result).toBe(true);
  });

  it("does not check an empty optional URL as a URL (the prop rule reports it as empty)", () => {
    expect(messages('<Image src="" alt="x" />')).toEqual(["the prop `src` of `<Image>` must not be empty"]);
  });

  it("reports every bad URL of a lesson", () => {
    const result = compileFixture("x", source("[a](javascript:1) and ![b](data:x)\n\n[c](vbscript:y)"));

    expect("problems" in result && result.problems.map((p) => [p.line, p.column])).toEqual([
      [6, 1],
      [6, 23],
      [8, 1],
    ]);
  });
});

describe("Markdown that looks like it could be unsafe but is only text", () => {
  it("does not reject an HTML-looking tag inside a code fence or inline code", () => {
    const result = compileFixture("x", "---\ntitle: T\norder: 1\n---\n\n```html\n<script>alert(1)</script>\n<div onclick=\"x\">{y}</div>\n```\n\n`<iframe />` and `{x}`\n");

    expect("tree" in result).toBe(true);
  });

  it("rejects the same text outside a code fence", () => {
    const result = compileFixture("x", "---\ntitle: T\norder: 1\n---\n\n<script>alert(1)</script>\n");

    expect("problems" in result && result.problems.map((p) => p.message)).toContain(SCRIPT);
  });
});

describe("a lesson without a body keeps working when it holds only problems of its own", () => {
  it("rejects a lesson of one bad line and reports its line in the file, not in the body", () => {
    const result = compileFixture("x", "---\ntitle: T\norder: 1\n---\n{1 + 1}\n");

    expect(result).toEqual({ problems: [lessonProblem("lessons/x.mdx", 5, 1, EXPRESSION)] });
  });
});
