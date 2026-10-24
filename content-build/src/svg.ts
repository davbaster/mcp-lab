// The SVG rules: a text scan, with no XML parser. It looks at the whole text, comments and CDATA included,
// so it may reject a harmless file; that is the point. It is one layer: `Image` and `Diagram` show an SVG
// as an `<img>` (#19), and the asset route sends `script-src 'none'` and `nosniff` (#58).

export type SvgProblem = {
  /** 1-based line of the first match of the rule. */
  line: number;
  message: string;
};

/** Elements that can run code, load a page, or change the picture over time. */
const BAD_ELEMENTS = ["script", "foreignObject", "iframe", "embed", "object", "animate", "set"];
const ELEMENT = new RegExp(`<\\s*(?:[A-Za-z_][\\w.-]*:)?(${BAD_ELEMENTS.join("|")})(?![\\w.:-])`, "i");
const SVG_START = /<\s*(?:[A-Za-z_][\w.-]*:)?svg(?![\w.:-])/i;
const XML_ENCODING = /<\?xml\b[^>]*?\bencoding\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
/** An attribute name that starts with `on`, after whitespace, a quote, or `/`, so `<svg/onload=...>` is found. */
const EVENT_ATTRIBUTE = /[\s"'/](on[\w:.-]+)\s*=/i;
const HREF = /[\s"'/]((?:[\w.-]+:)?href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))/gi;
/** `url(` whose argument, after optional spaces and a quote, is not `#`. */
const EXTERNAL_URL = /url\((?!\s*["']?#)/i;
/** `<!DOCTYPE` up to a `[` (an internal subset); quoted literals are skipped, so a `>` inside one does not end it early. */
const DOCTYPE_SUBSET = /<!DOCTYPE(?:[^>["']|"[^"]*"|'[^']*')*\[/i;

/**
 * Checks the normalized text of an SVG file (LF line endings, no byte order mark). Each rule is reported
 * once, with the line of its first match; the result is in line order.
 */
export function svgProblems(text: string): SvgProblem[] {
  const problems: SvgProblem[] = [];
  const lineAt = (index: number) => text.slice(0, index).split("\n").length;
  const add = (index: number, message: string) => problems.push({ line: lineAt(index), message });

  const nul = text.indexOf("\u0000");
  if (nul !== -1) add(nul, "the SVG contains a NUL character, so it is not text");

  const declared = XML_ENCODING.exec(text);
  const encoding = declared?.[1] ?? declared?.[2];
  if (declared !== null && encoding !== undefined && encoding.toLowerCase() !== "utf-8") {
    add(declared.index, `the XML declaration says the encoding is \`${encoding}\`; an SVG must be UTF-8`);
  }

  if (!SVG_START.test(text)) problems.push({ line: 1, message: "there is no `<svg` start tag, so this is not an SVG" });

  const element = ELEMENT.exec(text);
  if (element !== null) {
    add(element.index, `the SVG has a \`<${element[1]}>\` element, which can run code, load a page, or animate; remove it`);
  }

  const handler = EVENT_ATTRIBUTE.exec(text);
  if (handler !== null) {
    add(handler.index, `the SVG has the event-handler attribute \`${handler[1]}\`; no attribute whose name starts with \`on\` is allowed`);
  }

  for (const match of text.matchAll(HREF)) {
    const quoted = match[2] ?? match[3];
    if (quoted !== undefined && quoted.startsWith("#")) continue;
    const why = quoted === undefined ? "its value is not in quotes" : "its value does not start with `#`";
    add(match.index, `the SVG has a \`${match[1]}\` attribute and ${why}; only a link inside the file, such as href="#shape", is allowed`);
    break;
  }

  const subset = DOCTYPE_SUBSET.exec(text);
  if (subset !== null) {
    add(subset.index, "the SVG has a DOCTYPE with an internal subset (`<!DOCTYPE ... [`), which can declare entities or default attributes such as `onload`; remove the subset");
  }
  const entity = /<!ENTITY/i.exec(text);
  if (entity !== null) add(entity.index, "the SVG declares an entity (`<!ENTITY`), which can pull in other files or expand without limit");
  const sheet = /<\?xml-stylesheet/i.exec(text);
  if (sheet !== null) add(sheet.index, "the SVG has an `<?xml-stylesheet` instruction, which loads another file");

  const imported = /@import/i.exec(text);
  if (imported !== null) add(imported.index, "the SVG uses `@import`, which loads another file");
  const external = EXTERNAL_URL.exec(text);
  if (external !== null) add(external.index, "the SVG has a `url(` that does not point to `#id` inside the file; external addresses are not allowed");

  return problems.sort((a, b) => a.line - b.line);
}
