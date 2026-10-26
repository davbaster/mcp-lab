import { describe, expect, it } from "vitest";
import tokensCss from "../styles/tokens.css?raw";
import { SAMPLES } from "./codeSamples";
import css from "./content.css?raw";
import { highlight, languageForPath } from "./highlighter";

/** The WCAG contrast ratio of two #rrggbb colors. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const tokens = new Map(Array.from(tokensCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g), (m) => [m[1], m[2].trim()]));
const color = (name: string): string => {
  const value = tokens.get(name);
  expect(value, name).toMatch(/^#[0-9a-f]{6}$/);
  return value as string;
};

const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
/** The color token a class sets, from content.css. */
function tokenOfClass(className: string): string | null {
  const body = Array.from(withoutComments.matchAll(/([^{}]+)\{([^}]*)\}/g)).find((m) => m[1].split(",").map((x) => x.trim()).includes(`.${className}`))?.[2];
  return body?.match(/(?:^|[\s;])color:\s*var\((--[\w-]+)\)/)?.[1] ?? null;
}

const MIN = 4.5;
const surface = () => color("--color-surface");
const CODE_TOKENS = Array.from(tokens.keys()).filter((name) => name.startsWith("--color-code-"));

describe("the code colors", () => {
  it("has the nine code color tokens", () => {
    expect(CODE_TOKENS).toHaveLength(9);
  });

  it.each(CODE_TOKENS)("%s is at least 4.5:1 on --color-surface", (name) => {
    expect(contrast(color(name), surface())).toBeGreaterThanOrEqual(MIN);
  });

  it("keeps the default code text, --color-text, at least 4.5:1 on --color-surface", () => {
    expect(contrast(color("--color-text"), surface())).toBeGreaterThanOrEqual(MIN);
    expect(contrast(color("--color-text-muted"), surface())).toBeGreaterThanOrEqual(MIN);
  });

  const samples = Object.entries(SAMPLES);

  it.each(samples)("uses only colors that are at least 4.5:1 on --color-surface in the output for %s", async (path, content) => {
    const lines = await highlight(content, languageForPath(path)!);
    expect(lines).not.toBeNull();
    const classes = new Set(lines!.flat().flatMap((token) => (token.className === null ? [] : token.className.split(" "))));

    for (const className of classes) {
      // Italic, bold and underline set no color.
      if (!className.startsWith("code-token-")) continue;
      const token = tokenOfClass(className);
      expect(token, `${className} has no color in content.css`).not.toBeNull();
      expect(contrast(color(token!), surface()), className).toBeGreaterThanOrEqual(MIN);
    }
  });

  it("uses a token from the nine for every token class of the samples, and each of the nine in some sample", async () => {
    const used = new Set<string>();
    for (const [path, content] of samples) {
      const lines = await highlight(content, languageForPath(path)!);
      for (const token of lines!.flat()) {
        for (const className of token.className?.split(" ") ?? []) {
          if (className.startsWith("code-token-")) used.add(tokenOfClass(className)!);
        }
      }
    }
    for (const name of used) expect(CODE_TOKENS).toContain(name);
    // Every token the samples use is one of the nine, and together the samples reach all nine.
    expect([...used].sort()).toEqual([...CODE_TOKENS].sort());
  });

  it("draws code that has no token class in the --color-text color", () => {
    const area = withoutComments.match(/\.code-area\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(area).toMatch(/color:\s*var\(--color-text\)/);
  });
});

describe("the colors on a changed line and the labels", () => {
  const changed = () => color("--color-changed-line");

  it.each(CODE_TOKENS)("%s is at least 4.5:1 on --color-changed-line", (name) => {
    expect(contrast(color(name), changed())).toBeGreaterThanOrEqual(MIN);
  });

  it("keeps the default text and the line number color at least 4.5:1 on --color-changed-line", () => {
    expect(contrast(color("--color-text"), changed())).toBeGreaterThanOrEqual(MIN);
    expect(contrast(color("--color-text-muted"), changed())).toBeGreaterThanOrEqual(MIN);
  });

  it.each(Object.entries(SAMPLES))("uses only colors that are at least 4.5:1 on --color-changed-line in the output for %s", async (path, content) => {
    const lines = await highlight(content, languageForPath(path)!);
    expect(lines).not.toBeNull();
    const classes = new Set(lines!.flat().flatMap((token) => (token.className === null ? [] : token.className.split(" "))));
    for (const className of classes) {
      if (!className.startsWith("code-token-")) continue;
      expect(contrast(color(tokenOfClass(className)!), changed()), className).toBeGreaterThanOrEqual(MIN);
    }
  });

  it.each([
    ["New", "--color-success"],
    ["Changed", "--color-primary"],
    ["Deleted", "--color-danger"],
  ])("draws the %s label (%s) at least 4.5:1 on --color-bg and on the tab hover background, --color-surface", (_label, name) => {
    expect(contrast(color(name), color("--color-bg"))).toBeGreaterThanOrEqual(MIN);
    expect(contrast(color(name), color("--color-surface"))).toBeGreaterThanOrEqual(MIN);
  });

  it("takes the tab hover background from --color-surface", () => {
    const hover = withoutComments.match(/\.tab:hover\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(hover).toMatch(/background:\s*var\(--color-surface\)/);
  });
});
