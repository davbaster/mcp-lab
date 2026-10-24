// Compiling a valid lesson: the golden trees, the tree format, normalization, and "parse, never run".

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv } from "ajv";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_DEPTH, compileLesson } from "../src/lesson.ts";
import type { LessonResult } from "../src/lesson.ts";
import { serializeTree, treeErrors } from "../src/lesson-tree.ts";
import { COMPONENT_FIXTURES, LESSON_FIXTURES, PART_DIR, lessonProblem } from "./helpers.ts";

const HEADER = "---\ntitle: Case\norder: 1\n---\n";

/** The valid lesson fixtures; the schema folder says which components they may use. */
const VALID: Record<string, { schemaDir?: string }> = {
  markdown: {},
  components: {}, // the real schemas: it uses all seven components with all of their props
  "looks-like-code": {},
  "empty-body": {},
  "bare-attribute": { schemaDir: COMPONENT_FIXTURES },
};

function fixture(name: string): string {
  return readFileSync(join(LESSON_FIXTURES, "valid", `${name}.mdx`), "utf8");
}

function compile(source: string, schemaDir?: string): LessonResult {
  return compileLesson(source, { path: "lessons/case.mdx", ...(schemaDir === undefined ? {} : { schemaDir }) });
}

function tree(source: string, schemaDir?: string) {
  const result = compile(source, schemaDir);
  if ("problems" in result) throw new Error(`unexpected problems: ${JSON.stringify(result.problems)}`);
  return result.tree;
}

/** An independent check of a tree against the committed JSON Schema, with ajv in strict mode. */
const checkTree = new Ajv({ allErrors: true, strict: true }).compile(
  JSON.parse(readFileSync(join(PART_DIR, "schemas", "lesson-tree.schema.json"), "utf8")),
);

describe("golden trees", () => {
  it.each(Object.entries(VALID))("%s compiles to exactly the committed golden file", (name, { schemaDir }) => {
    const output = Buffer.from(serializeTree(tree(fixture(name), schemaDir)), "utf8");
    const golden = readFileSync(join(LESSON_FIXTURES, "valid", `${name}.json`));

    expect(output.equals(golden)).toBe(true);
  });

  it("has a golden file for every valid lesson and a lesson for every golden file", () => {
    expect(Object.keys(VALID).sort()).toEqual(["bare-attribute", "components", "empty-body", "looks-like-code", "markdown"]);
  });

  it.each(Object.keys(VALID))("the golden tree of %s is valid against lesson-tree.schema.json", (name) => {
    const golden = JSON.parse(readFileSync(join(LESSON_FIXTURES, "valid", `${name}.json`), "utf8"));

    expect(checkTree(golden), JSON.stringify(checkTree.errors)).toBe(true);
  });

  it("the golden files are LF text with a final newline and no byte order mark", () => {
    for (const name of Object.keys(VALID)) {
      const text = readFileSync(join(LESSON_FIXTURES, "valid", `${name}.json`), "utf8");
      expect(text.includes("\r"), name).toBe(false);
      expect(text.startsWith("\uFEFF"), name).toBe(false);
      expect(text.endsWith("}\n"), name).toBe(true);
    }
  });

  it("the markdown lesson covers every Markdown node of the tree format", () => {
    const seen = new Set<string>();
    const walk = (node: unknown) => {
      if (typeof node !== "object" || node === null) return;
      const { type, children } = node as { type?: string; children?: unknown[] };
      if (type !== undefined) seen.add(type);
      children?.forEach(walk);
    };
    walk(tree(fixture("markdown")));

    expect([...seen].sort()).toEqual(
      ["blockquote", "break", "code", "emphasis", "heading", "image", "inlineCode", "link", "list", "listItem", "paragraph", "root", "strong", "text", "thematicBreak"].sort(),
    );
  });

  it("the components lesson uses each of the seven components with all of its props", () => {
    const used = new Map<string, Set<string>>();
    const walk = (node: { type: string; name?: string; props?: Record<string, unknown>; children?: unknown[] }) => {
      if (node.type === "component" && node.name !== undefined) {
        const props = used.get(node.name) ?? new Set<string>();
        Object.keys(node.props ?? {}).forEach((key) => props.add(key));
        used.set(node.name, props);
      }
      (node.children as (typeof node)[] | undefined)?.forEach(walk);
    };
    walk(tree(fixture("components")));

    expect(Object.fromEntries([...used].map(([name, props]) => [name, [...props].sort()]))).toEqual({
      CodeSteps: ["file", "step"],
      Callout: ["title", "type"],
      Diagram: ["alt", "source", "src"],
      Image: ["alt", "src"],
      Model3D: ["alt", "poster", "src"],
      Tab: ["label"],
      Tabs: [],
      Video: ["captions", "poster", "src", "title"],
    });
  });
});

describe("the tree schema", () => {
  const valid = () => tree(fixture("markdown"));

  it("rejects a node with a position", () => {
    expect(checkTree({ type: "root", children: [{ type: "thematicBreak", position: { start: { line: 1 } } }] })).toBe(false);
  });

  it("rejects a field that is not in the format", () => {
    expect(checkTree({ type: "root", children: [{ type: "paragraph", children: [], spread: false }] })).toBe(false);
    expect(checkTree({ type: "root", children: [], data: {} })).toBe(false);
  });

  it("rejects a node type that the format does not have", () => {
    expect(checkTree({ type: "root", children: [{ type: "html", value: "<b>" }] })).toBe(false);
    expect(checkTree({ type: "root", children: [{ type: "mdxFlowExpression", value: "1" }] })).toBe(false);
  });

  it("rejects a heading depth outside 1 to 6", () => {
    expect(checkTree({ type: "root", children: [{ type: "heading", depth: 7, children: [] }] })).toBe(false);
    expect(checkTree({ type: "root", children: [{ type: "heading", depth: 0, children: [] }] })).toBe(false);
  });

  it("wants start on an ordered list and none on an unordered one", () => {
    expect(checkTree({ type: "root", children: [{ type: "list", ordered: true, children: [] }] })).toBe(false);
    expect(checkTree({ type: "root", children: [{ type: "list", ordered: false, start: 1, children: [] }] })).toBe(false);
    expect(checkTree({ type: "root", children: [{ type: "list", ordered: true, start: 1, children: [] }] })).toBe(true);
    expect(checkTree({ type: "root", children: [{ type: "list", ordered: false, children: [] }] })).toBe(true);
  });

  it("allows only a string or true as the value of a prop", () => {
    const component = (props: unknown) => ({ type: "root", children: [{ type: "component", name: "X", props, children: [] }] });

    expect(checkTree(component({ a: "x", b: true }))).toBe(true);
    expect(checkTree(component({ a: false }))).toBe(false);
    expect(checkTree(component({ a: 1 }))).toBe(false);
    expect(checkTree(component({ a: null }))).toBe(false);
    expect(checkTree(component({ a: { type: "x" } }))).toBe(false);
  });

  it("wants children on a component, even an empty list", () => {
    expect(checkTree({ type: "root", children: [{ type: "component", name: "X", props: {} }] })).toBe(false);
  });

  it("rejects a markdown node where a block is needed, and the other way round", () => {
    expect(checkTree({ type: "root", children: [{ type: "text", value: "x" }] })).toBe(false);
    expect(checkTree({ type: "root", children: [{ type: "paragraph", children: [{ type: "paragraph", children: [] }] }] })).toBe(false);
  });

  it("holds for the tree the compiler returns (checked again here, as the compiler checks it too)", () => {
    expect(checkTree(valid())).toBe(true);
  });
});

describe("treeErrors, the check the compiler runs on its own output", () => {
  it("finds nothing wrong with the golden trees", () => {
    for (const name of Object.keys(VALID)) {
      expect(treeErrors(JSON.parse(readFileSync(join(LESSON_FIXTURES, "valid", `${name}.json`), "utf8"))), name).toEqual([]);
    }
  });

  it.each([
    ["a position", { type: "root", children: [{ type: "thematicBreak", position: {} }] }],
    ["a field on the root", { type: "root", children: [], data: {} }],
    ["an unknown node type", { type: "root", children: [{ type: "html", value: "<b>" }] }],
    ["a prop that is a number", { type: "root", children: [{ type: "component", name: "X", props: { a: 1 }, children: [] }] }],
    ["an ordered list with no start", { type: "root", children: [{ type: "list", ordered: true, children: [] }] }],
  ])("finds %s", (_what, bad) => {
    expect(treeErrors(bad).length).toBeGreaterThan(0);
  });
});

describe("the tree format", () => {
  it("has the root { type: root, children }", () => {
    expect(tree(HEADER)).toEqual({ type: "root", children: [] });
  });

  it("compiles a lesson with front matter and no body to exactly the empty root", () => {
    expect(serializeTree(tree("---\ntitle: Empty\norder: 1\n---\n"))).toBe('{\n  "type": "root",\n  "children": []\n}\n');
    expect(JSON.stringify(tree("---\ntitle: Empty\norder: 1\n---"))).toBe('{"type":"root","children":[]}');
    expect(JSON.stringify(tree("---\ntitle: Empty\norder: 1\n---\n\n\n  \n"))).toBe('{"type":"root","children":[]}');
  });

  it("builds each node from its listed fields only, in a fixed order", () => {
    const body = [
      "# H",
      "",
      "[l](a.md 'T') ![i](b.png 'U') `c` *e* **s** x  ",
      "y",
      "",
      "```py",
      "z",
      "```",
      "",
      "3. a",
      "",
      "- b",
      "",
      "> q",
      "",
      "---",
    ].join("\n");

    expect(JSON.stringify(tree(`${HEADER}${body}\n`))).toBe(
      JSON.stringify({
        type: "root",
        children: [
          { type: "heading", depth: 1, children: [{ type: "text", value: "H" }] },
          {
            type: "paragraph",
            children: [
              { type: "link", url: "a.md", title: "T", children: [{ type: "text", value: "l" }] },
              { type: "text", value: " " },
              { type: "image", url: "b.png", alt: "i", title: "U" },
              { type: "text", value: " " },
              { type: "inlineCode", value: "c" },
              { type: "text", value: " " },
              { type: "emphasis", children: [{ type: "text", value: "e" }] },
              { type: "text", value: " " },
              { type: "strong", children: [{ type: "text", value: "s" }] },
              { type: "text", value: " x" },
              { type: "break" },
              { type: "text", value: "y" },
            ],
          },
          { type: "code", lang: "py", value: "z" },
          { type: "list", ordered: true, start: 3, children: [{ type: "listItem", children: [{ type: "paragraph", children: [{ type: "text", value: "a" }] }] }] },
          { type: "list", ordered: false, children: [{ type: "listItem", children: [{ type: "paragraph", children: [{ type: "text", value: "b" }] }] }] },
          { type: "blockquote", children: [{ type: "paragraph", children: [{ type: "text", value: "q" }] }] },
          { type: "thematicBreak" },
        ],
      }),
    );
  });

  it("leaves lang, title, and start out when they are not given", () => {
    const out = JSON.stringify(tree(`${HEADER}\`\`\`\nx\n\`\`\`\n\n[a](b)\n\n![](c.png)\n\n- x\n`));

    expect(out).not.toContain('"lang"');
    expect(out).not.toContain('"title"');
    expect(out).not.toContain('"start"');
    expect(out).toContain('"alt":""');
  });

  it("starts an ordered list at its own first number", () => {
    const list = tree(`${HEADER}\n7. a\n8. b\n`).children[0];

    expect(list).toMatchObject({ type: "list", ordered: true, start: 7 });
  });

  it("has no position, data, meta, or other parser field anywhere", () => {
    const text = JSON.stringify(tree(fixture("components")));
    const markdown = JSON.stringify(tree(fixture("markdown")));

    for (const key of ["position", "data", "estree", "meta", "spread", "checked", "referenceType", "identifier", "offset"]) {
      expect(text, key).not.toContain(`"${key}"`);
      expect(markdown, key).not.toContain(`"${key}"`);
    }
  });

  it("is data only: plain objects, arrays, strings, numbers, and booleans", () => {
    const check = (value: unknown) => {
      if (Array.isArray(value)) return value.forEach(check);
      if (typeof value === "object" && value !== null) {
        expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
        return Object.values(value).forEach(check);
      }
      expect(["string", "number", "boolean"]).toContain(typeof value);
    };
    check(tree(fixture("components")));
    check(tree(fixture("markdown")));
  });
});

describe("components in the tree", () => {
  it("writes a component as type, name, props, children, and children is [] when it takes none", () => {
    expect(JSON.stringify(tree(`${HEADER}\n<Image src="a.png" alt="A" />\n`, COMPONENT_FIXTURES))).toBe(
      '{"type":"root","children":[{"type":"component","name":"Image","props":{"alt":"A","src":"a.png"},"children":[]}]}',
    );
  });

  it("writes the props with their keys in code-unit sorted order, whatever order the author used", () => {
    const first = tree(`${HEADER}\n<Callout type="tip" title="T" />\n`, COMPONENT_FIXTURES);
    const second = tree(`${HEADER}\n<Callout title="T" type="tip" />\n`, COMPONENT_FIXTURES);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(Object.keys((first.children[0] as { props: object }).props)).toEqual(["title", "type"]);
  });

  it("writes a bare attribute as true and a value as the string the author wrote", () => {
    const [flag] = tree(`${HEADER}\n<Flag name="x" flag />\n`, COMPONENT_FIXTURES).children as { props: Record<string, unknown> }[];

    expect(flag?.props).toEqual({ flag: true, name: "x" });
  });

  it("decodes character references and keeps other text in a prop as written", () => {
    const [image] = tree(`${HEADER}\n<Image src="a.png?x=1&amp;y=2" alt="A 'quoted' &lt;b&gt; é" />\n`, COMPONENT_FIXTURES).children as {
      props: Record<string, unknown>;
    }[];

    expect(image?.props).toEqual({ alt: "A 'quoted' <b> é", src: "a.png?x=1&y=2" });
  });

  it("puts the Tab nodes inside the Tabs node", () => {
    const [tabs] = tree(fixture("components")).children.filter((node) => node.type === "component" && node.name === "Tabs");

    expect(tabs).toMatchObject({ children: [{ type: "component", name: "Tab" }, { type: "component", name: "Tab" }] });
  });

  it("accepts components inside a list item and a block quote", () => {
    const list = tree(`${HEADER}\n- item\n\n  <Callout type="tip" />\n\n> <Callout type="note" />\n`, COMPONENT_FIXTURES);

    expect(JSON.stringify(list)).toContain('"name":"Callout"');
  });
});

describe("text that looks like code but is not", () => {
  it("keeps a code fence and inline code verbatim, whatever they hold", () => {
    const out = tree(fixture("looks-like-code"));
    const code = out.children[1];

    expect(code).toEqual({ type: "code", lang: "python", value: "import x\n<script>\n{1 + 1}\nonClick" });
    expect(JSON.stringify(out.children[0])).toContain('{"type":"inlineCode","value":"import x"}');
    expect(JSON.stringify(out.children[0])).toContain('{"type":"inlineCode","value":"<script>"}');
    expect(JSON.stringify(out.children[0])).toContain('{"type":"inlineCode","value":"{1 + 1}"}');
    expect(JSON.stringify(out.children[0])).toContain('{"type":"inlineCode","value":"onClick"}');
  });

  it("keeps an escaped brace as a brace", () => {
    expect(tree(`${HEADER}\nA \\{ and \\} here.\n`).children).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "A { and } here." }] },
    ]);
  });

  it("keeps the text a < b", () => {
    expect(tree(`${HEADER}\nIf a < b then c > d.\n`).children).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "If a < b then c > d." }] },
    ]);
  });

  it("keeps a tilde fence and a fence that holds a closing component tag", () => {
    const out = tree(`${HEADER}\n~~~html\n<div onclick="x">{y}</div>\n~~~\n`);

    expect(out.children).toEqual([{ type: "code", lang: "html", value: '<div onclick="x">{y}</div>' }]);
  });
});

describe("front matter", () => {
  it("takes the block off with the same code as the course checks, and keeps the body's line numbers", () => {
    const result = compile("---\ntitle: T\norder: 1\n---\n\n\n{1 + 1}\n");

    expect(result).toEqual({ problems: [expect.objectContaining({ line: 7, column: 1 })] });
  });

  it("does not check what the front matter holds (the course check does)", () => {
    expect(tree("---\ntitle: 5\nbogus: [\n---\nText\n").children).toHaveLength(1);
    expect(tree("---\n---\nText\n").children).toHaveLength(1);
  });

  it("does not take a --- inside the body for the end of the front matter", () => {
    expect(tree(`${HEADER}\nText\n\n---\n\nMore\n`).children.map((node) => node.type)).toEqual(["paragraph", "thematicBreak", "paragraph"]);
  });

  it("rejects a lesson with no front matter with the course check's message", () => {
    const message = "the lesson must start with a front-matter block: a `---` line, the settings, and a closing `---` line";

    expect(compile("# Title\n")).toEqual({ problems: [lessonProblem("lessons/case.mdx", 1, 1, message)] });
    expect(compile("")).toEqual({ problems: [lessonProblem("lessons/case.mdx", 1, 1, message)] });
    expect(compile("\n---\ntitle: T\n---\n")).toEqual({ problems: [lessonProblem("lessons/case.mdx", 1, 1, message)] });
  });

  it("rejects an unclosed front matter with the course check's message", () => {
    expect(compile("---\ntitle: T\norder: 1\n\n# Body\n")).toEqual({
      problems: [lessonProblem("lessons/case.mdx", 1, 1, "the front matter that starts here has no closing `---` line")],
    });
  });

  it("accepts trailing spaces after the --- lines", () => {
    expect(tree("---  \ntitle: T\norder: 1\n---   \nText\n").children).toHaveLength(1);
  });
});

describe("line endings and the byte order mark", () => {
  const crlf = (text: string) => `\uFEFF${text.replaceAll("\n", "\r\n")}`;

  it.each(Object.entries(VALID))("%s compiles to the same bytes with CRLF endings and a byte order mark", (name, { schemaDir }) => {
    const lf = serializeTree(tree(fixture(name), schemaDir));
    const windows = serializeTree(tree(crlf(fixture(name)), schemaDir));

    expect(windows).toBe(lf);
    expect(windows).not.toContain("\r");
  });

  it("gives a CRLF file with a byte order mark the same text in a code fence and in a paragraph", () => {
    const out = tree(crlf(`${HEADER}\nOne\ntwo\n\n\`\`\`\na\n\nb\n\`\`\`\n`));

    expect(JSON.stringify(out)).not.toContain("\\r");
    expect(out.children[1]).toEqual({ type: "code", value: "a\n\nb" });
  });

  it("treats a lone CR as a line ending too", () => {
    const lf = serializeTree(tree(`${HEADER}\nOne\ntwo\n\n# Three\n`));

    expect(serializeTree(tree(`${HEADER}\nOne\rtwo\r\r# Three\r`.replaceAll("\n", "\r")))).toBe(lf);
  });

  it("removes only one byte order mark, as the course check does", () => {
    expect(compile(`\uFEFF\uFEFF${HEADER}\nText\n`)).toEqual({
      problems: [
        lessonProblem(
          "lessons/case.mdx",
          1,
          1,
          "the lesson must start with a front-matter block: a `---` line, the settings, and a closing `---` line",
        ),
      ],
    });
  });

  it("reports the same lines and columns for CRLF and for LF, with or without a byte order mark", () => {
    const lf = "---\ntitle: T\norder: 1\n---\n\nSome text\n\nA {1 + 1} here\n\n<Image src=\"a.png\" alt=\"A\" width={100} />\n";

    const expected = compile(lf, COMPONENT_FIXTURES);
    expect(expected).toEqual({
      problems: [
        lessonProblem("lessons/case.mdx", 8, 3, EXPRESSION),
        lessonProblem("lessons/case.mdx", 10, 28, "the value of the prop `width` is a JavaScript expression, which is not allowed; write a string, as in width=\"...\""),
      ],
    });
    expect(compile(lf.replaceAll("\n", "\r\n"), COMPONENT_FIXTURES)).toEqual(expected);
    expect(compile(`\uFEFF${lf}`, COMPONENT_FIXTURES)).toEqual(expected);
    expect(compile(crlf(lf), COMPONENT_FIXTURES)).toEqual(expected);
  });
});

const EXPRESSION =
  "JavaScript expressions in curly braces are not allowed; to show a brace as text, write `\\{` or put it in a code span";

describe("determinism", () => {
  it("compiling the same lesson twice gives byte-identical output", () => {
    const first = serializeTree(tree(fixture("components")));
    const second = serializeTree(tree(fixture("components")));

    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  });
});

describe("compiling never runs the lesson", () => {
  // The sentinel is a global that only evaluated lesson code could set.
  beforeEach(() => {
    delete (globalThis as { LESSON_RAN?: unknown }).LESSON_RAN;
  });

  it.each([
    ["an expression on its own line", "{globalThis.LESSON_RAN = true}\n"],
    ["an expression in a sentence", "Text {globalThis.LESSON_RAN = true} text\n"],
    ["an immediately invoked function", "{(() => { globalThis.LESSON_RAN = true })()}\n"],
    ["an expression in a prop", '<Image src="a.png" alt={globalThis.LESSON_RAN = true} />\n'],
    ["a spread in a prop", '<Image src="a.png" alt="A" {...(globalThis.LESSON_RAN = true, {})} />\n'],
    ["an export", "export const x = (globalThis.LESSON_RAN = true)\n"],
    ["an import", 'import x from "data:text/javascript,globalThis.LESSON_RAN=true"\n'],
    ["an expression inside a component", '<Callout type="tip">\n\n{globalThis.LESSON_RAN = true}\n\n</Callout>\n'],
    ["a top-level await", "{await (globalThis.LESSON_RAN = true)}\n"],
  ])("does not run %s", (_what, body) => {
    const result = compile(`${HEADER}\n${body}`, COMPONENT_FIXTURES);

    expect("problems" in result).toBe(true);
    expect((globalThis as { LESSON_RAN?: unknown }).LESSON_RAN).toBeUndefined();
  });

  it("does not run a valid lesson either", () => {
    tree(fixture("markdown"));
    tree(fixture("components"));

    expect((globalThis as { LESSON_RAN?: unknown }).LESSON_RAN).toBeUndefined();
  });
});

describe("nesting", () => {
  const quotes = (n: number) => `${HEADER}\n${">".repeat(n)} x\n`;
  const TOO_DEEP = `the lesson nests Markdown and components more than ${MAX_DEPTH} levels deep, which is not supported`;

  it("compiles deeply nested block quotes in a moment (the tree schema is checked in linear time)", () => {
    const out = tree(quotes(60));

    expect(JSON.stringify(out).match(/blockquote/g)).toHaveLength(60);
  });

  it("accepts the deepest nesting that is allowed and rejects one level more, with one problem", () => {
    expect(compile(quotes(MAX_DEPTH - 2))).toHaveProperty("tree");
    expect(compile(quotes(MAX_DEPTH - 1))).toEqual({ problems: [lessonProblem("lessons/case.mdx", 6, MAX_DEPTH + 1, TOO_DEEP)] });
  });

  it("reports a lesson nested thousands of levels deep once, and does not overflow the stack", () => {
    const result = compile(quotes(5000));

    expect("problems" in result && result.problems.map((p) => p.message)).toEqual([TOO_DEEP]);
  });

  it("reports nested components the same way", () => {
    const open = '<Callout type="tip">\n\n'.repeat(MAX_DEPTH);
    const close = "</Callout>\n\n".repeat(MAX_DEPTH);
    const result = compile(`${HEADER}\n${open}x\n\n${close}`, COMPONENT_FIXTURES);

    expect("problems" in result && result.problems.map((p) => p.message)).toEqual([TOO_DEEP]);
  });
});
