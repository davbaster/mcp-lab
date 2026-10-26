/**
 * Syntax highlighting with Shiki, loaded only when a code viewer needs it (#21; #63 uses the same
 * function for code blocks in lesson prose). Nothing from Shiki is imported at the top of this
 * file: the core, the JavaScript regex engine (never the WASM one) and each grammar are separate
 * `import()` calls, so a lesson without code pays nothing, and a viewer only loads the grammars of
 * the files it shows. The grammar table is a fixed object of explicit calls; a computed
 * `import(`...${name}`)` would make the build bundle every grammar.
 *
 * Shiki's CSS-variables theme gives each token a `color` such as `var(--shiki-token-keyword)`.
 * That is turned into a fixed class (`code-token-keyword`) that content.css colors from the
 * `--color-code-*` tokens. The result is plain data (text and class names), so callers build React
 * elements from it. Nothing is ever turned into HTML, and no color is set inline.
 */
import { splitLines } from "./codeLines";

export type Language = "python" | "toml" | "json" | "yaml" | "markdown" | "shellscript";

/** Files over this many characters are shown as plain text, so the page does not freeze. */
export const MAX_HIGHLIGHT_CHARS = 100_000;

/** The file extension (lower case) of the last path segment; a name that only starts with a dot has none. */
const EXTENSIONS: ReadonlyMap<string, Language> = new Map([
  ["py", "python"],
  ["toml", "toml"],
  ["json", "json"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
  ["md", "markdown"],
  ["sh", "shellscript"],
  ["bash", "shellscript"],
]);

/** The grammar for a file path, or null (plain text). Only the text after the last `.` counts. */
export function languageForPath(path: string): Language | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return EXTENSIONS.get(name.slice(dot + 1).toLowerCase()) ?? null;
}

/** A piece of a line. `className` is the token's classes, or null for default text. */
export interface HighlightedToken {
  text: string;
  className: string | null;
}
/** One list of tokens for each line of the text (see `splitLines`), without line breaks. */
export type HighlightedLines = HighlightedToken[][];

// The variables of Shiki's CSS-variables theme that content.css has a color for. Any other
// (`foreground`, the `ansi-*` ones, diff colors) is default text.
const COLORS: ReadonlySet<string> = new Set([
  "comment",
  "constant",
  "keyword",
  "parameter",
  "function",
  "string",
  "string-expression",
  "punctuation",
  "link",
]);
const COLOR_VARIABLE = /^var\(--shiki-token-([a-z-]+)\)$/;
// Shiki's FontStyle bit flags.
const ITALIC = 1;
const BOLD = 2;
const UNDERLINE = 4;
const THEME = "css-variables";

function classOf(color: string | undefined, fontStyle: number | undefined): string | null {
  const names: string[] = [];
  const name = color === undefined ? undefined : COLOR_VARIABLE.exec(color)?.[1];
  if (name !== undefined && COLORS.has(name)) names.push(`code-token-${name}`);
  if (fontStyle !== undefined && fontStyle > 0) {
    if (fontStyle & ITALIC) names.push("code-italic");
    if (fontStyle & BOLD) names.push("code-bold");
    if (fontStyle & UNDERLINE) names.push("code-underline");
  }
  return names.length > 0 ? names.join(" ") : null;
}

/** What is loaded for real. A test passes smaller stand-ins to `createHighlighter`. */
export interface HighlighterModules {
  core: () => Promise<typeof import("shiki/core")>;
  engine: () => Promise<typeof import("shiki/engine/javascript")>;
  grammars: Readonly<Record<Language, () => Promise<unknown>>>;
}

const modules: HighlighterModules = {
  core: () => import("shiki/core"),
  engine: () => import("shiki/engine/javascript"),
  grammars: {
    python: () => import("@shikijs/langs/python"),
    toml: () => import("@shikijs/langs/toml"),
    json: () => import("@shikijs/langs/json"),
    yaml: () => import("@shikijs/langs/yaml"),
    markdown: () => import("@shikijs/langs/markdown"),
    shellscript: () => import("@shikijs/langs/shellscript"),
  },
};

type Core = Awaited<ReturnType<HighlighterModules["core"]>>;
type Highlighter = Awaited<ReturnType<Core["createHighlighterCore"]>>;

export function createHighlighter(deps: HighlighterModules) {
  let highlighter: Promise<Highlighter> | null = null;
  const grammars = new Map<Language, Promise<void>>();

  function getHighlighter(): Promise<Highlighter> {
    if (highlighter === null) {
      const started = (async () => {
        const [core, engine] = await Promise.all([deps.core(), deps.engine()]);
        return core.createHighlighterCore({
          themes: [core.createCssVariablesTheme({ name: THEME })],
          langs: [],
          engine: engine.createJavaScriptRegexEngine(),
        });
      })();
      highlighter = started;
      // A failure is not kept, so a later call can try again (a blocked chunk may load next time).
      started.catch(() => {
        if (highlighter === started) highlighter = null;
      });
    }
    return highlighter;
  }

  function loadGrammar(instance: Highlighter, language: Language): Promise<void> {
    let loading = grammars.get(language);
    if (loading === undefined) {
      const started = deps.grammars[language]().then((grammar) => instance.loadLanguage(grammar as never));
      loading = started;
      grammars.set(language, started);
      started.catch(() => {
        if (grammars.get(language) === started) grammars.delete(language);
      });
    }
    return loading;
  }

  /**
   * The text as tokens, line by line, or null when it should stay plain text: it is too long, the
   * highlighter or the grammar could not be loaded or threw, or the tokens do not add up to the
   * text (so highlighting can never change what a learner reads or copies). Never rejects. It
   * logs only a `console.warn` with an error name, never the text.
   */
  async function highlight(text: string, language: Language): Promise<HighlightedLines | null> {
    if (text.length > MAX_HIGHLIGHT_CHARS) return null;
    if (text === "") return [];
    try {
      const instance = await getHighlighter();
      // The grammar only for the language that is asked for, and only once.
      await loadGrammar(instance, language);
      const themed = instance.codeToTokensBase(text, { lang: language, theme: THEME });
      const lines = splitLines(text);
      // After a final newline Shiki adds one more, empty, line, which is not a line of the file.
      const surplus = themed.length - lines.length;
      if (surplus < 0 || surplus > 1 || (surplus === 1 && !themed[lines.length].every((token) => token.content === ""))) return null;
      const result: HighlightedLines = [];
      for (let index = 0; index < lines.length; index += 1) {
        const tokens = themed[index].map((token) => ({ text: token.content, className: classOf(token.color, token.fontStyle) }));
        if (tokens.map((token) => token.text).join("") !== lines[index].text) return null;
        result.push(tokens);
      }
      return result;
    } catch (thrown) {
      const name = typeof thrown === "object" && thrown !== null && "name" in thrown ? String(thrown.name) : "error";
      console.warn(`Code highlighting is not available (${name}); the code is shown as plain text.`);
      return null;
    }
  }

  return { highlight };
}

const shared = createHighlighter(modules);

/** See `createHighlighter`. Loads Shiki the first time it is called. */
export const highlight = shared.highlight;
