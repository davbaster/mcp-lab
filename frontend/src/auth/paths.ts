/**
 * Links to the sign-in and register pages, and the safe target of the `next` query value.
 * Every page that sends a visitor to sign in builds its link with `signInPath`, so `next` is
 * always written the same way.
 */

/** `/login?next=/courses/x`: the value is encoded, except that `/` stays readable. */
function withNext(path: string, next?: string | null): string {
  if (!next) return path;
  return `${path}?next=${encodeURIComponent(next).replace(/%2F/gi, "/")}`;
}

export function signInPath(next?: string | null): string {
  return withNext("/login", next);
}

export function registerPath(next?: string | null): string {
  return withNext("/register", next);
}

// Control characters include tab and newline.
// eslint-disable-next-line no-control-regex
const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f-\u009f\\]/;
const FORM_PAGES = new Set(["/login", "/register"]);

/**
 * Where to go after signing in. Only a path on this site is accepted: it starts with `/`, its
 * second character is not `/` or `\`, and it has no backslash or control character. The query
 * and hash are kept. Anything else, and the sign-in and register pages themselves (which would
 * loop), gives `/`.
 */
export function nextTarget(next: string | null | undefined): string {
  if (!next || !next.startsWith("/")) return "/";
  if (next[1] === "/" || next[1] === "\\" || CONTROL_OR_BACKSLASH.test(next)) return "/";
  const path = next.split(/[?#]/, 1)[0].replace(/\/+$/, "").toLowerCase();
  if (FORM_PAGES.has(path)) return "/";
  return next;
}

/**
 * What the "Sign in" and "Create account" links should return to from this page: the page's own
 * path, query and hash, except on the sign-in and register pages, which keep their own `next`
 * (so a link there never points back at itself). Used by the header and by the feedback dialog.
 */
export function returnTarget(location: { pathname: string; search: string; hash: string }): string | null {
  const onFormPage = FORM_PAGES.has(location.pathname.replace(/\/+$/, "").toLowerCase());
  if (onFormPage) return new URLSearchParams(location.search).get("next");
  return `${location.pathname}${location.search}${location.hash}`;
}
