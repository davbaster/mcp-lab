/**
 * What a URL from a lesson may become. Author text is untrusted: a link is only live when its
 * scheme is known, and a media source is only used when it is a path on this site.
 */

export type LinkTarget =
  /** A page of this app: the router's `Link`. */
  | { kind: "app"; to: string }
  /** A plain `<a href>`: mail, the same page, or a path the router has no route for. */
  | { kind: "plain"; href: string }
  /** Another site: a new tab, with `noopener noreferrer`. */
  | { kind: "external"; href: string }
  /** Not a link: only its text is shown. */
  | { kind: "text" };

const TEXT: LinkTarget = { kind: "text" };

/**
 * Removes what a browser removes before it reads a URL: tabs and line breaks anywhere, and
 * control characters and spaces at the start and end. Without this, `java\tscript:` would pass
 * for a relative URL here and run as a script there.
 */
// eslint-disable-next-line no-control-regex
const BEFORE_PARSING = /^[\u0000- ]+|[\u0000- ]+$|[\t\n\r]/g;

function clean(url: string): string {
  return url.replace(BEFORE_PARSING, "");
}

/** `/x` but not `//x`, and not `/\x` (a browser reads a backslash as a slash). */
const SITE_PATH = /^\/(?![/\\])/;
/** The API is behind the same origin, but the router has no route for it. */
const API_PATH = /^\/api(?:[/?#]|$)/i;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

function sitePath(path: string): LinkTarget {
  return API_PATH.test(path) ? { kind: "plain", href: path } : { kind: "app", to: path };
}

export function classifyLink(url: unknown): LinkTarget {
  if (typeof url !== "string") return TEXT;
  const value = clean(url);
  if (value === "") return TEXT;
  if (SITE_PATH.test(value)) return sitePath(value);
  if (value.startsWith("#") || value.startsWith("?")) return { kind: "plain", href: value };

  const scheme = SCHEME.exec(value)?.[1].toLowerCase();
  if (scheme === "mailto") return { kind: "plain", href: value };
  if (scheme === "http" || scheme === "https") {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return TEXT;
    }
    if (parsed.origin === window.location.origin) return sitePath(`${parsed.pathname}${parsed.search}${parsed.hash}`);
    return { kind: "external", href: parsed.href };
  }
  // Any other scheme, and every other relative URL (`../a.md`, `images/pic.png`, `//host/x`).
  return TEXT;
}

/** The `src` of an image, diagram or other media: a path on this site, else null. */
export function siteSource(url: unknown): string | null {
  if (typeof url !== "string") return null;
  // No clean-up here: a source with a control character in it is not used at all.
  // eslint-disable-next-line no-control-regex
  if (!SITE_PATH.test(url) || /[\u0000- \u007f]/.test(url)) return null;
  return url;
}
