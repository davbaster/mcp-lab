// Checks the asset and media references that a compiled lesson makes (`compileLesson(...).references`).

import { MARKDOWN_IMAGE, isUrl, referenceRule } from "./assets.ts";
import type { LessonReference, ReferenceRule } from "./assets.ts";
import type { Kind } from "./folder.ts";
import type { MediaConfig } from "./media-config.ts";
import { mediaUrlProblem } from "./media-url.ts";
import type { Problem } from "./problem.ts";

const NAME_RULE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** What is in assets/, by path with `/`. */
export type AssetIndex = ReadonlyMap<string, Kind>;

/** How a reference is called in a message: ``the prop `src` of `<Image>` ``, or `a Markdown image`. */
function describe(ref: LessonReference): string {
  if (ref.component === MARKDOWN_IMAGE.component && ref.prop === MARKDOWN_IMAGE.prop) return "the Markdown image";
  return `the prop \`${ref.prop}\` of \`<${ref.component}>\``;
}

/**
 * Why an asset path (a value with no scheme) cannot be used, or undefined when its form is fine. It looks
 * at the text only; whether the file exists is a separate question. One reason per path, the first that applies.
 */
export function assetPathProblem(path: string): string | undefined {
  if (path === "") return "the path is empty";
  if (path.startsWith("/") || path.startsWith("\\")) {
    return "the path starts with a slash; write it relative to assets/, as in `images/pic.png`";
  }
  if (path.includes("\\")) return "the path has a backslash; separate folders with `/`";
  if (/[%?#]/.test(path)) return "the path has a `%`, `?`, or `#`; a path never needs URL-encoding, so name the file with letters, digits, `.`, `_`, and `-`";
  const segments = path.split("/");
  if (segments.some((segment) => segment === "")) return "the path has an empty part (`//` or a final `/`)";
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "the path has a `.` or `..` part; write the path from assets/ down, without leaving it";
  }
  if (segments.some((segment) => !NAME_RULE.test(segment))) {
    return "the path has a name with a character that file names in assets/ may not have; only letters, digits, `.`, `_`, and `-` are allowed, and a name may not start with `.`";
  }
  return undefined;
}

function typeList(rule: ReferenceRule): string {
  return rule.types.map((type) => `.${type}`).join(", ");
}

/**
 * Checks every reference of one lesson that compiled and returns its problems (each at the line and column
 * of the prop or the Markdown image). An asset path is looked up in `assets` by exact name, never by opening
 * a file. The paths of the files that exist and are used are added to `used`.
 */
export function checkReferences(
  references: readonly LessonReference[],
  file: string,
  assets: AssetIndex,
  config: MediaConfig,
  used: Set<string>,
): Problem[] {
  const problems: Problem[] = [];
  for (const ref of references) {
    const message = referenceProblem(ref, assets, config, used);
    if (message !== undefined) problems.push({ severity: "error", file, line: ref.line, column: ref.column, message });
  }
  return problems;
}

function referenceProblem(ref: LessonReference, assets: AssetIndex, config: MediaConfig, used: Set<string>): string | undefined {
  const rule = referenceRule(ref.component, ref.prop);
  if (rule === undefined) return undefined;
  const what = describe(ref);

  if (rule.kind === "video") {
    const reason = mediaUrlProblem(ref.value, "video", config);
    return reason === undefined ? undefined : `${what}: ${reason}`;
  }

  if (isUrl(ref.value)) {
    if (!rule.mediaUrl) {
      return `${what}: the file must be in assets/, not at the address \`${ref.value}\` (the Content-Security-Policy would block it); write its path from assets/, as in \`images/pic.png\``;
    }
    const reason = mediaUrlProblem(ref.value, ref.prop === "captions" ? "captions" : "poster", config);
    return reason === undefined ? undefined : `${what}: ${reason}`;
  }

  const form = assetPathProblem(ref.value);
  if (form !== undefined) return `${what}: ${form}`;

  const kind = assets.get(ref.value);
  if (kind === "directory") return `${what}: \`${ref.value}\` is a folder in assets/, not a file`;
  if (kind === undefined) {
    const lower = ref.value.toLowerCase();
    const sameLetters = [...assets.keys()].find((path) => path.toLowerCase() === lower);
    const hint = sameLetters === undefined ? "" : `; the file \`${sameLetters}\` exists, but names are case-sensitive`;
    return `${what}: there is no file \`${ref.value}\` in assets/${hint}`;
  }
  if (kind === "other") return `${what}: \`${ref.value}\` is not a plain file`;

  const extension = ref.value.slice(ref.value.lastIndexOf(".") + 1).toLowerCase();
  if (!rule.types.some((type) => type === extension)) {
    return `${what}: \`${ref.value}\` is the wrong type; this prop needs ${rule.types.length > 1 ? "one of " : "a "}${typeList(rule)}${rule.types.length > 1 ? "" : " file"}`;
  }
  used.add(ref.value);
  return undefined;
}
