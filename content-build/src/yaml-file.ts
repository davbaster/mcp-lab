// Parsing YAML text so that every problem found later can point at a line.

import { LineCounter, isMap, isNode, isScalar, isSeq, parseDocument, visit } from "yaml";
import type { Document } from "yaml";

export type PathSegment = string | number;

export type ParsedYaml = {
  /** The parsed value. `undefined` when the text is not valid YAML; an empty document is `null`. */
  value: unknown;
  /** Syntax errors from the parser, each with the line it reports. */
  errors: { line: number; message: string }[];
  /** The line of the key (or list item) at `path`, if the path exists. */
  lineOf(path: readonly PathSegment[]): number | undefined;
  /** The line of the key `name` in the mapping at `path`. */
  lineOfKey(path: readonly PathSegment[], name: string): number | undefined;
};

/** The text without a leading UTF-8 byte order mark. */
export function stripBom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

/**
 * Parses one YAML document. A repeated mapping key is an error. `firstLine` is the line number that
 * the first line of `text` has in its file (2 for the front matter of a lesson).
 */
export function parseYaml(text: string, firstLine = 1): ParsedYaml {
  const lineCounter = new LineCounter();
  const doc = parseDocument(stripBom(text), { uniqueKeys: true, lineCounter, prettyErrors: false });
  const lineAt = (offset: number) => lineCounter.linePos(offset).line + firstLine - 1;

  // One error per line: the parser often reports several for a single mistake.
  const errors = doc.errors
    .map((error) => ({ line: lineAt(error.pos[0]), message: error.message }))
    .filter((error, index, all) => all.findIndex((other) => other.line === error.line) === index);
  if (errors.length === 0) {
    const failure = toJSFailure(doc, lineAt);
    if (failure !== undefined) errors.push(failure);
  }
  return {
    value: errors.length > 0 ? undefined : doc.toJS(),
    errors,
    lineOf: (path) => lineOfPath(doc, path, lineAt),
    lineOfKey: (path, name) => lineOfKey(doc, path, name, lineAt),
  };
}

/**
 * The parser reports an alias without an anchor, and an alias bomb, only when the value is built, by
 * throwing. This turns that into a problem with fixed text, so the name in the file is never repeated.
 */
function toJSFailure(doc: Document, lineAt: (offset: number) => number): { line: number; message: string } | undefined {
  try {
    doc.toJS();
    return undefined;
  } catch (error) {
    const bomb = error instanceof Error && error.message.startsWith("Excessive alias count");
    // The line of the first alias that has no anchor (for a bomb, of the first alias).
    let line = 1;
    visit(doc, {
      Alias(_key, alias) {
        const start = alias.range?.[0];
        if (start === undefined || (!bomb && alias.resolve(doc) !== undefined)) return;
        line = lineAt(start);
        return visit.BREAK;
      },
    });
    const message = bomb
      ? "Excessive alias count indicates a resource exhaustion attack"
      : isUnresolved(error)
        ? "Unresolved alias (the anchor must be set before the alias)"
        : "The YAML cannot be read";
    return { line, message };
  }
}

function isUnresolved(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Unresolved alias");
}

function lineOfKey(
  doc: Document,
  path: readonly PathSegment[],
  name: string,
  lineAt: (offset: number) => number,
): number | undefined {
  const map = path.length === 0 ? doc.contents : doc.getIn(path, true);
  if (!isMap(map)) return undefined;
  const key = map.items.find((pair) => isScalar(pair.key) && pair.key.value === name)?.key;
  const start = isScalar(key) ? key.range?.[0] : undefined;
  return start === undefined ? undefined : lineAt(start);
}

function lineOfPath(
  doc: Document,
  path: readonly PathSegment[],
  lineAt: (offset: number) => number,
): number | undefined {
  const last = path.at(-1);
  if (last === undefined) return undefined;
  const parentPath = path.slice(0, -1);
  if (typeof last === "string") return lineOfKey(doc, parentPath, last, lineAt);
  const parent = parentPath.length === 0 ? doc.contents : doc.getIn(parentPath, true);
  const item = isSeq(parent) ? parent.items[last] : undefined;
  const start = isNode(item) ? item.range?.[0] : undefined;
  return start === undefined ? undefined : lineAt(start);
}
