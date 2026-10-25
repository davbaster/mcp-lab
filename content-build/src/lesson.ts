// Compiles a lesson .mdx file to a JSON tree of Markdown nodes and allowlisted component nodes.
//
// The text is parsed to a syntax tree and never evaluated: remark-parse and remark-mdx only read it, and
// this file only reads the tree. Every node of the output is built by listing its fields, so nothing
// else from the parser (positions, parser data) reaches it.

import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { splitFrontMatter } from "./chapter.ts";
import { MARKDOWN_IMAGE, referenceRule } from "./assets.ts";
import type { LessonReference } from "./assets.ts";
import { DEFAULT_SCHEMA_DIR, loadComponentSchemas } from "./component-schemas.ts";
import type { ComponentSchema, ComponentSchemas } from "./component-schemas.ts";
import { treeErrors } from "./lesson-tree.ts";
import type {
  BlockNode,
  ComponentNode,
  HeadingNode,
  LessonTree,
  ListItemNode,
  ListNode,
  PhrasingNode,
} from "./lesson-tree.ts";
import { toPosix } from "./problem.ts";
import type { Problem } from "./problem.ts";
import { compareText } from "./text.ts";
import { urlProblem } from "./url.ts";

export type LessonOptions = {
  /** The lesson's path, used as `file` in its problems (`\` is written as `/`). */
  path: string;
  /** The folder of the component schemas. Defaults to the frontend's, found from this file, not from the working folder. */
  schemaDir?: string;
  /** Schemas that were loaded already by `loadComponentSchemas`; used instead of reading `schemaDir`. */
  components?: ComponentSchemas;
};

/**
 * Either the tree and the asset and media references the lesson makes (in the order they appear, each with
 * the line and column of the prop or the Markdown image), the `CodeSteps` tags (in the order they appear),
 * the `Diagram` tags that have Mermaid `source` (in the order they appear), or the problems, never both. A lesson
 * problem is never thrown. The references, the tags, and the diagrams are next to the tree, not in it: the tree
 * keeps `source` as the author wrote it.
 */
export type LessonResult =
  | { tree: LessonTree; references: LessonReference[]; codeSteps: CodeStepUse[]; diagrams: DiagramUse[] }
  | { problems: Problem[] };

/**
 * A `<Diagram>` tag of a lesson that has a `source` prop. `source` and `alt` are the props as the author wrote them (the text
 * of the Mermaid source is what MDX made of the prop: character references such as `&quot;` are decoded, and the spaces at
 * the start of every line are gone). `line` and `column` are the position of the `source` prop; `tagLine` and `tagColumn`
 * are the position of the tag.
 */
export type DiagramUse = { source: string; alt: string; line: number; column: number; tagLine: number; tagColumn: number };

/** A `<CodeSteps>` tag of a lesson, with the line and column of the tag. `step` and `file` are the props as the author wrote them. */
export type CodeStepUse = { step: string; file?: string; line: number; column: number };

// ---- the parser's tree: only what this file reads ------------------------------------------------------

type Point = { line: number; column: number };
type MdAttribute = { type: string; name?: string; value?: unknown; position?: { start: Point } };
type MdNode = {
  type: string;
  position?: { start: Point };
  children?: MdNode[];
  value?: unknown;
  name?: string | null;
  attributes?: MdAttribute[];
  [field: string]: unknown;
};

const processor = unified().use(remarkParse).use(remarkMdx);

/** How deep Markdown and components may be nested in each other. Real lessons use a handful of levels. */
export const MAX_DEPTH = 100;

type Context = {
  file: string;
  components: ComponentSchemas;
  problems: Problem[];
  references: LessonReference[];
  codeSteps: CodeStepUse[];
  diagrams: DiagramUse[];
  depth: number;
};

/**
 * Compiles the text of one lesson. Reads no file except the component schemas. A bad schema is a setup
 * problem of the build and throws a `SetupError`; anything wrong with the lesson comes back as problems,
 * each with the file, the line, and the column.
 */
export function compileLesson(source: string, options: LessonOptions): LessonResult {
  const file = toPosix(options.path);
  const components = options.components ?? loadComponentSchemas(options.schemaDir ?? DEFAULT_SCHEMA_DIR);

  // Every line ending becomes LF, so a CRLF file gives the same tree and the same positions as an LF file.
  // A byte order mark is on the first line, which is front matter, so splitFrontMatter drops it and the body never has one.
  const text = source.replace(/\r\n?/g, "\n");
  const front = splitFrontMatter(text);
  if ("problem" in front) return { problems: [{ severity: "error", file, line: 1, column: 1, message: front.problem }] };

  // The front matter lines are blanked, not cut, so every position the parser reports is a line of the file.
  const body = "\n".repeat(front.closingLine) + text.split("\n").slice(front.closingLine).join("\n");
  let root: MdNode;
  try {
    root = processor.parse(body) as unknown as MdNode;
  } catch (error) {
    return { problems: [parseProblem(file, error)] };
  }

  const ctx: Context = { file, components, problems: [], references: [], codeSteps: [], diagrams: [], depth: 0 };
  const tree: LessonTree = { type: "root", children: convertBlocks(ctx, root.children ?? []) };
  if (ctx.problems.length > 0) return { problems: sortByPosition(ctx.problems) };

  const wrong = treeErrors(tree);
  if (wrong.length > 0) throw new Error(`internal error: the compiled tree does not match lesson-tree.schema.json: ${wrong.join("; ")}`);
  return { tree, references: sortReferences(ctx.references), codeSteps: sortCodeSteps(ctx.codeSteps), diagrams: sortDiagrams(ctx.diagrams) };
}

function sortReferences(references: LessonReference[]): LessonReference[] {
  return [...references].sort((a, b) => a.line - b.line || a.column - b.column || compareText(a.prop, b.prop));
}

function sortCodeSteps(uses: CodeStepUse[]): CodeStepUse[] {
  return [...uses].sort((a, b) => a.line - b.line || a.column - b.column);
}

function sortDiagrams(uses: DiagramUse[]): DiagramUse[] {
  return [...uses].sort((a, b) => a.tagLine - b.tagLine || a.tagColumn - b.tagColumn);
}

/** Notes a reference to an asset or a media file, at the position of the prop or the Markdown image. */
function addReference(ctx: Context, at: { position?: { start: Point } } | undefined, component: string, prop: string, value: string) {
  const start = at?.position?.start;
  ctx.references.push({ component, prop, value, line: start?.line ?? 1, column: start?.column ?? 1 });
}

function sortByPosition(problems: Problem[]): Problem[] {
  return [...problems].sort(
    (a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0) || compareText(a.message, b.message),
  );
}

/** A parse error becomes one problem at the position the parser gives. */
function parseProblem(file: string, error: unknown): Problem {
  const failure = error as { reason?: unknown; line?: unknown; column?: unknown; message?: unknown } | null;
  const reason = typeof failure?.reason === "string" ? failure.reason : undefined;
  if (reason === undefined) throw error;
  let line = typeof failure?.line === "number" ? failure.line : undefined;
  let column = typeof failure?.column === "number" ? failure.column : undefined;
  if (line === undefined || column === undefined) {
    // Some errors (an unclosed tag) carry the position of the tag only inside the text: "(3:1-3:10)".
    const inText = /\((\d+):(\d+)-\d+:\d+\)\s*$/.exec(reason);
    line = inText?.[1] === undefined ? 1 : Number(inText[1]);
    column = inText?.[2] === undefined ? 1 : Number(inText[2]);
  }
  return { severity: "error", file, line, column, message: reason };
}

function add(ctx: Context, at: { position?: { start: Point } } | undefined, message: string) {
  const start = at?.position?.start;
  ctx.problems.push({ severity: "error", file: ctx.file, line: start?.line ?? 1, column: start?.column ?? 1, message });
}

const NOT_SUPPORTED = "is not supported in a lesson";

// ---- blocks --------------------------------------------------------------------------------------------

/** `parent` is the component these nodes are the children of, which can name components that exist only inside it. */
function convertBlocks(ctx: Context, nodes: MdNode[], parent?: ComponentSchema): BlockNode[] {
  if (tooDeep(ctx, nodes[0])) return [];
  ctx.depth += 1;
  const blocks = convertBlockNodes(ctx, nodes, parent);
  ctx.depth -= 1;
  return blocks;
}

const TOO_DEEP = `the lesson nests Markdown and components more than ${MAX_DEPTH} levels deep, which is not supported`;

/** True, and one problem, when `ctx` is already at the limit. Only the first node past the limit is reported. */
function tooDeep(ctx: Context, at: MdNode | undefined): boolean {
  if (ctx.depth < MAX_DEPTH) return false;
  if (!ctx.problems.some((problem) => problem.message === TOO_DEEP)) add(ctx, at, TOO_DEEP);
  return true;
}

function convertBlockNodes(ctx: Context, nodes: MdNode[], parent?: ComponentSchema): BlockNode[] {
  const blocks: BlockNode[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "heading":
        blocks.push({ type: "heading", depth: Number(node.depth) as HeadingNode["depth"], children: convertPhrasing(ctx, node.children) });
        break;
      case "paragraph":
        blocks.push({ type: "paragraph", children: convertPhrasing(ctx, node.children) });
        break;
      case "blockquote":
        blocks.push({ type: "blockquote", children: convertBlocks(ctx, node.children ?? []) });
        break;
      case "list":
        blocks.push(convertList(ctx, node));
        break;
      case "code": {
        if (typeof node.meta === "string" && node.meta !== "") {
          add(ctx, node, "a code fence can have only a language after the opening fence; remove the text after the language");
        }
        const lang = typeof node.lang === "string" && node.lang !== "" ? { lang: node.lang } : {};
        blocks.push({ type: "code", ...lang, value: String(node.value ?? "") });
        break;
      }
      case "thematicBreak":
        blocks.push({ type: "thematicBreak" });
        break;
      case "mdxJsxFlowElement": {
        const component = convertFlowElement(ctx, node, parent);
        if (component !== undefined) blocks.push(component);
        break;
      }
      case "mdxFlowExpression":
        add(ctx, node, EXPRESSION);
        break;
      case "mdxjsEsm":
        add(ctx, node, "`import` and `export` statements are not allowed in a lesson");
        break;
      case "definition":
        add(ctx, node, "link reference definitions (`[label]: url`) are not supported; write the URL in the link itself");
        break;
      default:
        add(ctx, node, `this Markdown (\`${node.type}\`) ${NOT_SUPPORTED}`);
    }
  }
  return blocks;
}

const EXPRESSION =
  "JavaScript expressions in curly braces are not allowed; to show a brace as text, write `\\{` or put it in a code span";

function convertList(ctx: Context, node: MdNode): ListNode {
  const items: ListItemNode[] = [];
  for (const item of node.children ?? []) {
    if (item.type === "listItem") items.push({ type: "listItem", children: convertBlocks(ctx, item.children ?? []) });
    else add(ctx, item, `this Markdown (\`${item.type}\`) ${NOT_SUPPORTED}`);
  }
  if (node.ordered !== true) return { type: "list", ordered: false, children: items };
  return { type: "list", ordered: true, start: typeof node.start === "number" ? node.start : 1, children: items };
}

// ---- inline content ------------------------------------------------------------------------------------

function convertPhrasing(ctx: Context, nodes: MdNode[] | undefined): PhrasingNode[] {
  if (tooDeep(ctx, nodes?.[0])) return [];
  ctx.depth += 1;
  const out = convertPhrasingNodes(ctx, nodes);
  ctx.depth -= 1;
  return out;
}

function convertPhrasingNodes(ctx: Context, nodes: MdNode[] | undefined): PhrasingNode[] {
  const out: PhrasingNode[] = [];
  for (const node of nodes ?? []) {
    switch (node.type) {
      case "text":
        out.push({ type: "text", value: String(node.value ?? "") });
        break;
      case "emphasis":
        out.push({ type: "emphasis", children: convertPhrasing(ctx, node.children) });
        break;
      case "strong":
        out.push({ type: "strong", children: convertPhrasing(ctx, node.children) });
        break;
      case "inlineCode":
        out.push({ type: "inlineCode", value: String(node.value ?? "") });
        break;
      case "break":
        out.push({ type: "break" });
        break;
      case "link": {
        const url = String(node.url ?? "");
        checkUrl(ctx, node, url, "link");
        const title = typeof node.title === "string" ? { title: node.title } : {};
        out.push({ type: "link", url, ...title, children: convertPhrasing(ctx, node.children) });
        break;
      }
      case "image": {
        const url = String(node.url ?? "");
        checkUrl(ctx, node, url, "image");
        addReference(ctx, node, MARKDOWN_IMAGE.component, MARKDOWN_IMAGE.prop, url);
        const title = typeof node.title === "string" ? { title: node.title } : {};
        out.push({ type: "image", url, alt: typeof node.alt === "string" ? node.alt : "", ...title });
        break;
      }
      case "mdxTextExpression":
        add(ctx, node, EXPRESSION);
        break;
      case "mdxJsxTextElement":
        convertTextElement(ctx, node);
        break;
      case "linkReference":
        add(ctx, node, "reference-style links are not supported; write the link as [text](url)");
        break;
      case "imageReference":
        add(ctx, node, "reference-style images are not supported; write the image as ![alt](url)");
        break;
      default:
        add(ctx, node, `this Markdown (\`${node.type}\`) ${NOT_SUPPORTED}`);
    }
  }
  return out;
}

function checkUrl(ctx: Context, node: MdNode, url: string, what: string) {
  const reason = urlProblem(url);
  if (reason !== undefined) add(ctx, node, `${what}: ${reason}`);
}

// ---- components ----------------------------------------------------------------------------------------

/** A component on its own lines. Returns the node, or undefined when the element was reported. */
function convertFlowElement(ctx: Context, el: MdNode, parent: ComponentSchema | undefined): ComponentNode | undefined {
  const head = checkHead(ctx, el, parent);
  if (head.schema === undefined) {
    convertBlocks(ctx, el.children ?? []); // for the problems inside
    return undefined;
  }
  checkChildren(ctx, el, head.schema);
  const children = convertBlocks(ctx, el.children ?? [], head.schema);
  return { type: "component", name: head.schema.name, props: head.props, children };
}

/** A tag inside a paragraph: components are block-level only, so a valid one is reported too. */
function convertTextElement(ctx: Context, el: MdNode) {
  const head = checkHead(ctx, el, undefined);
  if (head.schema !== undefined) {
    add(
      ctx,
      el,
      `\`<${head.schema.name}>\` is inside a paragraph; put the opening and closing tags on their own lines, with a blank line before and after the content`,
    );
  }
  convertPhrasing(ctx, el.children);
}

type Head = { schema?: ComponentSchema; props: Record<string, string | true> };

/**
 * Everything about an element that does not depend on its children: code in its attributes, its name,
 * and its props. `schema` is set when the element is a known component, whether or not its props are valid.
 */
function checkHead(ctx: Context, el: MdNode, parent: ComponentSchema | undefined): Head {
  const attributes = el.attributes ?? [];
  let literal = true; // false when an attribute holds code, so the props cannot be known
  const written: MdAttribute[] = [];
  for (const attribute of attributes) {
    if (attribute.type === "mdxJsxExpressionAttribute") {
      add(ctx, attribute, "a spread attribute `{...}` is not allowed; write each prop as a plain string");
      literal = false;
    } else if (typeof attribute.name === "string" && /^on/i.test(attribute.name)) {
      add(ctx, attribute, `the event-handler attribute \`${attribute.name}\` is not allowed; no attribute whose name starts with \`on\` is`);
    } else if (typeof attribute.value === "object" && attribute.value !== null) {
      add(
        ctx,
        attribute,
        `the value of the prop \`${String(attribute.name)}\` is a JavaScript expression, which is not allowed; write a string, as in ${String(attribute.name)}="..."`,
      );
      literal = false;
    } else {
      written.push(attribute);
    }
  }

  const name = el.name;
  if (name === null || name === undefined) {
    add(ctx, el, "a fragment (`<>`) is not allowed; use a component or plain Markdown");
    return { props: {} };
  }
  if (name.includes(":") || name.includes(".")) {
    add(ctx, el, `the name \`<${name}>\` is not allowed; a component name is one plain word, such as \`Callout\``);
    return { props: {} };
  }
  if (/^\p{Ll}/u.test(name)) {
    add(
      ctx,
      el,
      name === "script"
        ? "`<script>` is not allowed in a lesson"
        : `the HTML element \`<${name}>\` is not allowed; use Markdown or one of the components`,
    );
    return { props: {} };
  }
  const schema = parent?.nested.get(name) ?? ctx.components.get(name);
  if (schema === undefined) {
    const names = [...(parent?.nested.keys() ?? []), ...ctx.components.keys()].map((n) => `\`${n}\``);
    add(ctx, el, `unknown component \`${name}\`; the components are ${names.join(", ")}`);
    return { props: {} };
  }
  return { schema, props: literal ? checkProps(ctx, el, schema, written) : {} };
}

/** Checks the props the author wrote against the component's schema. Returns them with the keys in sorted order. */
function checkProps(ctx: Context, el: MdNode, schema: ComponentSchema, written: MdAttribute[]): Record<string, string | true> {
  const tag = `<${schema.name}>`;
  const given = new Map<string, string | true>();
  const where = new Map<string, MdAttribute>();
  for (const attribute of written) {
    const name = String(attribute.name);
    if (!schema.props.has(name)) {
      const allowed = schema.props.size === 0 ? "it takes no props" : `its props are ${[...schema.props.keys()].map((p) => `\`${p}\``).join(", ")}`;
      add(ctx, attribute, `\`${tag}\` has an unknown prop \`${name}\`; ${allowed}`);
    } else if (given.has(name)) {
      add(ctx, attribute, `the prop \`${name}\` of \`${tag}\` is written more than once`);
    } else {
      given.set(name, typeof attribute.value === "string" ? attribute.value : true);
      where.set(name, attribute);
    }
  }

  const props = Object.fromEntries([...given].sort(([a], [b]) => compareText(a, b)));
  if (!schema.validate(props)) {
    const messages = new Set<string>();
    for (const error of schema.validate.errors ?? []) {
      const prop = error.instancePath.slice(1);
      const at = where.get(prop) ?? el;
      const mine = `the prop \`${prop}\` of \`${tag}\``;
      let message: string | undefined;
      if (error.keyword === "required") {
        if (error.schemaPath.includes("/oneOf/")) continue; // said once, by the oneOf error
        message = `\`${tag}\` is missing the required prop \`${String(error.params.missingProperty)}\``;
      } else if (error.keyword === "oneOf") {
        const choices = schema.oneOf.map((names) => names.map((n) => `\`${n}\``).join(" and "));
        const passing = error.params.passingSchemas;
        message = `\`${tag}\` needs exactly one of ${choices.join(" or ")}, but it has ${Array.isArray(passing) ? "both" : "neither"}`;
      } else if (error.keyword === "type") {
        message =
          error.params.type === "string"
            ? `${mine} needs a value, as in ${prop}="..."`
            : `${mine} is a bare attribute and takes no value; write just \`${prop}\``;
      } else if (error.keyword === "enum") {
        message = `${mine} must be one of ${(error.params.allowedValues as string[]).map((v) => `\`${v}\``).join(", ")}`;
      } else if (error.keyword === "pattern") {
        message = `${mine} must match the pattern \`${String(error.params.pattern)}\``;
      } else if (error.keyword === "minLength") {
        message = `${mine} must not be empty`;
      } else {
        message = `${mine} ${error.message ?? "is not valid"}`;
      }
      if (!messages.has(message)) {
        messages.add(message);
        add(ctx, error.keyword === "required" || error.keyword === "oneOf" ? el : at, message);
      }
    }
  }

  const step = given.get("step");
  if (schema.name === "CodeSteps" && typeof step === "string") {
    const file = given.get("file");
    const start = el.position?.start;
    ctx.codeSteps.push({ step, ...(typeof file === "string" ? { file } : {}), line: start?.line ?? 1, column: start?.column ?? 1 });
  }

  const diagramSource = given.get("source");
  const diagramAlt = given.get("alt");
  if (schema.name === "Diagram" && typeof diagramSource === "string" && typeof diagramAlt === "string") {
    const prop = where.get("source")?.position?.start;
    const tag = el.position?.start;
    ctx.diagrams.push({
      source: diagramSource,
      alt: diagramAlt,
      line: prop?.line ?? 1,
      column: prop?.column ?? 1,
      tagLine: tag?.line ?? 1,
      tagColumn: tag?.column ?? 1,
    });
  }

  for (const [name, value] of given) {
    if (schema.props.get(name)?.url !== true || typeof value !== "string") continue;
    const reason = urlProblem(value);
    if (reason !== undefined) add(ctx, where.get(name), `the prop \`${name}\` of \`${tag}\`: ${reason}`);
    else if (referenceRule(schema.name, name) !== undefined) addReference(ctx, where.get(name), schema.name, name, value);
  }
  return props;
}

/** The children a component may hold, as its schema says (`x-children`). */
function checkChildren(ctx: Context, el: MdNode, schema: ComponentSchema) {
  const rule = schema.children;
  const tag = `<${schema.name}>`;
  const nodes = (el.children ?? []).filter((n) => n.type !== "mdxFlowExpression" && n.type !== "mdxjsEsm"); // code is reported on its own
  if (!rule.markdown && Array.isArray(rule.components) && rule.components.length === 0) {
    const first = nodes[0];
    if (first !== undefined) add(ctx, first, `\`${tag}\` takes no children; write it as ${tag.slice(0, -1)} ... /> or put nothing between the tags`);
    return;
  }
  const only = rule.components === "all" ? "components" : rule.components.map((n) => `\`<${n}>\``).join(", ");
  let count = 0;
  for (const node of nodes) {
    if (node.type !== "mdxJsxFlowElement") {
      if (!rule.markdown) add(ctx, node, `\`${tag}\` can contain only ${only}, not Markdown`);
      continue;
    }
    const known = typeof node.name === "string" && (schema.nested.get(node.name) ?? ctx.components.get(node.name)) !== undefined;
    if (!known) continue; // an unknown or forbidden name is reported where it stands
    if (Array.isArray(rule.components) && !rule.components.includes(String(node.name))) {
      add(ctx, node, `\`${tag}\` cannot contain \`<${String(node.name)}>\`; it can contain only ${only}`);
    } else {
      count += 1;
    }
  }
  if (rule.min !== undefined && count < rule.min) {
    add(ctx, el, `\`${tag}\` needs at least ${rule.min} ${only}${rule.components === "all" ? "" : " elements"} but has ${count}`);
  }
}
