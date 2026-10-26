// The checks on the Mermaid text of a `<Diagram source="...">` that need no browser, and the line numbers of the text.
//
// These run in `validate`, `compile`-based checks, and `build` alike, before anything is drawn.

/** The diagram types that the build draws: the first word of the first line that is not blank and not a `%%` comment. */
export const DIAGRAM_TYPES: readonly string[] = [
  "flowchart",
  "graph",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "pie",
];

/** The most Unicode characters a source may have (after CRLF becomes LF), and the most lines. Mermaid is told the same limit as `maxTextSize`. */
export const MAX_SOURCE_CHARACTERS = 5000;
export const MAX_SOURCE_LINES = 200;

/** A problem of a source: the 1-based line inside the source, and the message. */
export type SourceProblem = { line: number; message: string };

/** The source as the build uses it everywhere (for the cache key too): every line ending is LF. */
export function normalizeSource(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

const TYPE_LIST = DIAGRAM_TYPES.map((type) => `\`${type}\``).join(", ");

/** NUL and the other control characters (C0, DEL, C1) except tab and line break. */
function isControl(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f);
}

/**
 * The type of the diagram and the 1-based line it is on: the first word of the first line that is not blank and
 * does not start with `%%`. Undefined when there is no such line.
 */
export function diagramType(source: string): { type: string; line: number } | undefined {
  const lines = normalizeSource(source).split("\n");
  for (const [index, text] of lines.entries()) {
    const line = text.trim();
    if (line === "" || line.startsWith("%%")) continue;
    return { type: /^[^\s;]+/.exec(line)?.[0] ?? line, line: index + 1 };
  }
  return undefined;
}

/** True when a statement of the line starts with `click` and a space: in a flowchart that makes a link or runs a callback. A `;` ends a statement unless it is inside double quotes. */
function hasClickStatement(line: string): boolean {
  let atStart = true;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line.charAt(i);
    if (atStart && char !== " " && char !== "\t") {
      atStart = false;
      if (/^click[ \t]/i.test(line.slice(i))) return true;
    }
    if (char === '"') quoted = !quoted;
    else if (char === ";" && !quoted) atStart = true;
  }
  return false;
}

/**
 * What is wrong with a source that can be seen without drawing it. Each rule is reported once, at the first line that breaks it
 * (the limits at the first line past the limit), in line order.
 */
export function diagramSourceProblems(source: string): SourceProblem[] {
  const text = normalizeSource(source);
  const lines = text.split("\n");
  const problems: SourceProblem[] = [];
  const add = (line: number, message: string) => problems.push({ line, message });

  const control = lines.findIndex((line) => [...line].some(isControl));
  if (control !== -1) {
    add(control + 1, "the diagram source has a NUL or other control character (only tab and line breaks are allowed); remove it");
  }

  const characters = [...text];
  if (characters.length > MAX_SOURCE_CHARACTERS) {
    const line = characters.slice(0, MAX_SOURCE_CHARACTERS + 1).join("").split("\n").length;
    add(line, `the diagram source has ${characters.length} characters, but the most allowed is ${MAX_SOURCE_CHARACTERS}; split it into smaller diagrams`);
  }
  // A final line break does not start a line of its own.
  const lineCount = text.endsWith("\n") ? lines.length - 1 : lines.length;
  if (lineCount > MAX_SOURCE_LINES) {
    add(MAX_SOURCE_LINES + 1, `the diagram source has ${lineCount} lines, but the most allowed is ${MAX_SOURCE_LINES}; split it into smaller diagrams`);
  }

  const directive = lines.findIndex((line) => line.includes("%%{"));
  if (directive !== -1) {
    add(directive + 1, "the diagram source has a `%%{` directive, which can change the settings of the drawing (for example, switch HTML labels on); remove it");
  }

  const first = lines.findIndex((line) => line.trim() !== "");
  const frontMatter = first !== -1 && (lines[first] ?? "").trim().startsWith("---");
  if (frontMatter) {
    add(first + 1, "the diagram source starts with `---` (front matter), which can set the configuration of the drawing; remove it");
  }

  const click = lines.findIndex(hasClickStatement);
  if (click !== -1) add(click + 1, "the diagram source has a `click` statement, which makes a link or runs a callback; diagrams cannot have links, so remove it");

  const found = diagramType(text);
  if (found === undefined) {
    if (!frontMatter) add(1, `the diagram source has no diagram: its first line must name the type, one of ${TYPE_LIST}`);
  } else if (!frontMatter && !DIAGRAM_TYPES.includes(found.type)) {
    add(found.line, `the diagram type \`${found.type}\` is not supported; the supported types are ${TYPE_LIST}`);
  }
  return problems.sort((a, b) => a.line - b.line);
}

/**
 * The lesson position of line `line` (1-based) of a source, given the position of the `source` prop: the prop's line plus the
 * line minus 1, and the prop's column for the first line and 1 for the later ones.
 */
export function sourcePosition(prop: { line: number; column: number }, line: number): { line: number; column: number } {
  return { line: prop.line + line - 1, column: line === 1 ? prop.column : 1 };
}

/**
 * Mermaid counts the lines of the text it parses after it removes the leading blank space and every comment line
 * (`/^\s*%%(?!{)[^\n]+\n?/gm`, then `trimStart`). This gives the line of the source (1-based) for a line number that Mermaid
 * names (1-based), by doing the same removal and keeping where each character came from. A number past the end gives the last line.
 */
export function sourceLineOfMermaidLine(source: string, mermaidLine: number): number {
  const text = normalizeSource(source);
  const origins: number[] = [];
  const kept: string[] = [];
  let position = 0;
  const keep = (until: number) => {
    for (; position < until; position += 1) {
      kept.push(text.charAt(position));
      origins.push(position);
    }
  };
  for (const match of text.matchAll(/^\s*%%(?!{)[^\n]+\n?/gm)) {
    keep(match.index);
    position = match.index + match[0].length;
  }
  keep(text.length);
  let start = 0;
  while (start < kept.length && /\s/.test(kept[start] ?? "")) start += 1;

  let index = start;
  for (let line = 1; line < mermaidLine && index < kept.length; ) {
    if (kept[index] === "\n") line += 1;
    index += 1;
  }
  const origin = origins[Math.min(index, origins.length - 1)] ?? 0;
  return text.slice(0, origin).split("\n").length;
}
