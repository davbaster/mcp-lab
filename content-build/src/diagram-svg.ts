// What the build does to an SVG that Mermaid wrote, and the checks it must pass.
//
// `finishSvg` runs before the SVG is cached; `labelSvg` (the accessible name) runs after the cache, because it depends on `alt`
// and not on the source. Nothing here removes or repairs content that the SVG rules reject: a rejected SVG is an error.

/**
 * The version of everything in code that changes the bytes of a rendered diagram: `finishSvg`, the options of the render call
 * (the SVG id, the viewport, the background, font embedding), and the flags of the browser. It is part of the cache key. Raise it
 * when you change any of them.
 */
export const POSTPROCESS_VERSION = 1;

/** The `id` of the root `<svg>` that Mermaid is told to write, and the `id` of the `<title>` that `labelSvg` adds. */
export const SVG_ID = "diagram";
export const TITLE_ID = `${SVG_ID}-title`;

const ROOT = /^<svg\b([^>]*)>/;
const ATTRIBUTE = /\s([A-Za-z_][\w:.-]*)="([^"]*)"/g;

/** The attributes of the root tag, in order. Mermaid's text is XML written by the browser: values are quoted and `>` is escaped. */
function rootAttributes(tag: string): [string, string][] {
  return [...tag.matchAll(ATTRIBUTE)].map((match) => [match[1] ?? "", match[2] ?? ""]);
}

function rootTag(attributes: readonly (readonly [string, string])[]): string {
  return `<svg${attributes.map(([name, value]) => ` ${name}="${value}"`).join("")}>`;
}

function withAttribute(attributes: [string, string][], name: string, value: string): [string, string][] {
  const found = attributes.some(([existing]) => existing === name);
  return found ? attributes.map(([existing, old]) => [existing, existing === name ? value : old]) : [...attributes, [name, value]];
}

/**
 * Gives the root `<svg>` a numeric `width` and `height` equal to the size in its `viewBox`, so that it shows at its natural size
 * in an `<img>` and shrinks with CSS. Returns the problem when the text is not an SVG that Mermaid wrote or has no usable `viewBox`.
 */
export function finishSvg(raw: string): { svg: string } | { problem: string } {
  const root = ROOT.exec(raw);
  if (root === null) return { problem: "Mermaid did not write an <svg> element" };
  const attributes = rootAttributes(root[0]);
  const viewBox = attributes.find(([name]) => name === "viewBox")?.[1];
  const numbers = viewBox?.trim().split(/[\s,]+/).map(Number) ?? [];
  const [width, height] = [numbers[2], numbers[3]];
  if (numbers.length !== 4 || numbers.some((n) => !Number.isFinite(n)) || width === undefined || height === undefined || width <= 0 || height <= 0) {
    return { problem: "the SVG that Mermaid wrote has no usable viewBox, so its size is not known" };
  }
  let updated = withAttribute(attributes, "width", String(width));
  updated = withAttribute(updated, "height", String(height));
  return { svg: rootTag(updated) + raw.slice(root[0].length) };
}

/**
 * Text for the content of an element: `&`, `<`, and `>` are escaped, and a character that XML 1.0 cannot hold becomes U+FFFD.
 * `=` is written as a character reference too (the same text), so that alt text such as `one = 1` is not taken for an attribute
 * by the SVG rules, which scan the whole text.
 */
export function escapeText(text: string): string {
  const canHold = (character: string) => {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0xfffe || code === 0xffff) return false;
    return code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
  };
  return [...text]
    .map((character) => (canHold(character) ? character : "\ufffd"))
    .join("")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/=/g, "&#61;");
}

/**
 * Adds the accessible name: `<title id="diagram-title">` with the `alt` text as the first child, `role="img"`, and `aria-labelledby`
 * pointing at the title. Mermaid's own `<title>` (from `accTitle`) is replaced; a `<desc>` (from `accDescr`) stays.
 * `svg` is what `finishSvg` returned.
 */
export function labelSvg(svg: string, alt: string): string {
  const root = ROOT.exec(svg);
  if (root === null) throw new Error("internal error: labelSvg needs the SVG that finishSvg returned");
  let attributes = withAttribute(rootAttributes(root[0]), "role", "img");
  attributes = withAttribute(attributes, "aria-labelledby", TITLE_ID);
  const rest = svg.slice(root[0].length).replace(/^<title\b[^>]*>[\s\S]*?<\/title>/, "");
  return `${rootTag(attributes)}<title id="${TITLE_ID}">${escapeText(alt)}</title>${rest}`;
}
