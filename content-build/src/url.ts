// The one rule for the URLs in a lesson: Markdown links and images, and the URL props of components.

const ALLOWED_SCHEMES = new Set(["http", "https", "mailto"]);

/**
 * Why a URL may not be used, or undefined when it may. Relative URLs (`../a.md`, `/x`, `#section`,
 * `?q=1`) and `http`, `https`, and `mailto` URLs are fine; any other scheme (`javascript:`, `data:`,
 * `vbscript:`, `file:`, ...) and a URL that starts with `//` are not.
 *
 * It reads the URL the way a browser does, so a trick does not get past it: letters in any case, tabs
 * and line breaks inside the scheme (`java<tab>script:`), and spaces or control characters before the URL.
 */
export function urlProblem(url: string): string | undefined {
  const clean = url.replace(/[\t\n\r]/g, "").replace(/^[\s\p{Cc}\p{Cf}]+/u, "");
  // A browser reads `\` as `/` in a web address, so `/\host` is `//host` too.
  if (clean.replaceAll("\\", "/").startsWith("//")) {
    return "a URL that starts with `//` is not allowed; write the whole http or https address, or a path that starts with one `/`";
  }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(clean)?.[1];
  if (scheme === undefined || ALLOWED_SCHEMES.has(scheme.toLowerCase())) return undefined;
  return `the URL scheme \`${scheme}:\` is not allowed; use http, https, mailto, or a relative URL`;
}
