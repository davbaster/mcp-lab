// mermaid-config.json: the only place the render settings live. Its keys are fixed, and its colors are the design system's.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SetupError } from "../src/component-schemas.ts";
import { DEFAULT_MERMAID_CONFIG, loadMermaidConfig } from "../src/mermaid-config.ts";
import { PART_DIR, temporaryFolder } from "./helpers.ts";

const DESIGN_SYSTEM = join(PART_DIR, "..", "_docs", "design-system.md");
const SETTINGS = loadMermaidConfig().settings;
const THEME = SETTINGS.themeVariables as Record<string, string>;

/** The color tokens of the table in _docs/design-system.md: token name to value. */
function designTokens(): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const line of readFileSync(DESIGN_SYSTEM, "utf8").split("\n")) {
    const row = /^\| `(--color-[a-z-]+)` \| `(#[0-9a-f]{6})` \|/.exec(line);
    if (row?.[1] !== undefined && row[2] !== undefined) tokens.set(row[1], row[2]);
  }
  return tokens;
}

/** The WCAG contrast ratio of two #rrggbb colors. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, b2] = [1, 3, 5].map((i) => {
      const channel = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

function changed(change: (settings: Record<string, unknown>) => void): string {
  const settings = JSON.parse(readFileSync(DEFAULT_MERMAID_CONFIG, "utf8")) as Record<string, unknown>;
  change(settings);
  const path = join(temporaryFolder(), "mermaid-config.json");
  writeFileSync(path, JSON.stringify(settings));
  return path;
}

describe("the settings that keep the output safe and the same everywhere", () => {
  it("fixes the look, the seed, the theme, the label type, the security level, and the limits", () => {
    expect(SETTINGS).toMatchObject({
      look: "classic",
      handDrawnSeed: 1,
      theme: "base",
      htmlLabels: false,
      securityLevel: "strict",
      maxTextSize: 5000,
      maxEdges: 100,
    });
  });

  it("turns htmlLabels off and useMaxWidth off in the section of each supported type (pie has no labels of HTML)", () => {
    for (const type of ["flowchart", "sequence", "class", "state", "er"]) {
      expect(SETTINGS[type], type).toEqual({ htmlLabels: false, useMaxWidth: false });
    }
    expect(SETTINGS.pie).toEqual({ useMaxWidth: false });
  });

  it("names the font that the renderer bundles first, so the layout does not depend on the fonts of the machine", () => {
    expect(THEME.fontFamily).toMatch(/^"Recursive Variable",/);
  });

  // Mermaid measures a text with the top-level fontFamily (and with sans-serif, and takes the wider). A sequence diagram reads no
  // other setting, so without it that diagram was 12 px taller on a machine with other fonts (found by the one-font fontconfig test).
  it("sets the same font list at the top level, which the layout of a sequence diagram reads, and refuses another", () => {
    expect(SETTINGS.fontFamily).toBe(THEME.fontFamily);
    expect(() => loadMermaidConfig(changed((settings) => (settings.fontFamily = "Arial")))).toThrow(/`fontFamily`/);
    expect(() => loadMermaidConfig(changed((settings) => delete settings.fontFamily))).toThrow(/fontFamily/);
  });

  it("has no keys other than these (an unknown key is a setup error)", () => {
    expect(Object.keys(SETTINGS).sort()).toEqual(
      ["class", "er", "flowchart", "fontFamily", "handDrawnSeed", "htmlLabels", "look", "maxEdges", "maxTextSize", "pie", "securityLevel", "sequence", "state", "theme", "themeVariables"].sort(),
    );
    expect(() => loadMermaidConfig(changed((settings) => (settings.fontSize = 3)))).toThrow(/unknown key `fontSize`/);
  });

  it.each([
    ["securityLevel", "loose"],
    ["htmlLabels", true],
    ["look", "handDrawn"],
    ["theme", "default"],
    ["maxTextSize", 90000],
    ["handDrawnSeed", 2],
  ])("refuses a config that sets %s to %j", (key, value) => {
    const path = changed((settings) => (settings[key as string] = value));

    expect(() => loadMermaidConfig(path)).toThrow(SetupError);
    expect(() => loadMermaidConfig(path)).toThrow(new RegExp(`mermaid-config\\.json: \`${key}\``));
  });

  it("refuses an htmlLabels or useMaxWidth that is on in a diagram section, and a font that is not the bundled one first", () => {
    expect(() => loadMermaidConfig(changed((settings) => ((settings.flowchart as Record<string, unknown>).htmlLabels = true)))).toThrow(/`flowchart.htmlLabels`/);
    expect(() => loadMermaidConfig(changed((settings) => ((settings.pie as Record<string, unknown>).useMaxWidth = true)))).toThrow(/`pie.useMaxWidth`/);
    expect(() => loadMermaidConfig(changed((settings) => ((settings.themeVariables as Record<string, unknown>).fontFamily = "Arial")))).toThrow(/fontFamily/);
  });

  it("refuses a file that is not JSON, and a file that is missing, with a setup error that names the file", () => {
    const path = join(temporaryFolder(), "mermaid-config.json");
    writeFileSync(path, "{");

    expect(() => loadMermaidConfig(path)).toThrow(/mermaid-config\.json: the file is not valid JSON/);
    expect(() => loadMermaidConfig(join(temporaryFolder(), "none.json"))).toThrow(/none\.json: the file cannot be read/);
  });
});

describe("the colors are the colors of the design system", () => {
  const tokens = designTokens();
  const values = new Set(tokens.values());

  it("reads the table of the design system", () => {
    expect(tokens.get("--color-text")).toBe("#1d2330");
    expect(tokens.size).toBeGreaterThanOrEqual(16);
  });

  it("has every #rrggbb of the config in that table", () => {
    const used = readFileSync(DEFAULT_MERMAID_CONFIG, "utf8").match(/#[0-9a-fA-F]{6}\b/g) ?? [];

    expect(used.length).toBeGreaterThan(30);
    expect(used.filter((color) => !values.has(color))).toEqual([]);
  });

  it("has no color in another form (a name, rgb(), hsl(), or a short hex)", () => {
    const strings = Object.entries(THEME).filter(([key, value]) => typeof value === "string" && key !== "fontFamily" && key !== "fontSize" && !/^pie(Title|Section|Legend)TextSize$/.test(key));

    expect(strings.filter(([, value]) => !/^#[0-9a-f]{6}$/.test(String(value)) && !/^[\d.]+(px)?$/.test(String(value))).map(([key]) => key)).toEqual([]);
  });

  /**
   * The text colors on fills that the design system lists with a contrast of at least 4.5:1 (the Contrast column and the
   * callout notes), as [text, fill, listed contrast].
   */
  const LISTED: [string, string, number][] = [
    ["--color-text", "--color-bg", 15.7],
    ["--color-text", "--color-surface", 14.7],
    ["--color-text-muted", "--color-bg", 7.8],
    ["--color-text", "--color-tip-bg", 14.2],
    ["--color-text", "--color-warning-bg", 14.6],
    ["--color-text", "--color-note-bg", 13.8],
    ["--color-text", "--color-changed-line", 14.1],
    ["--color-bg", "--color-text", 15.7],
    ["--color-danger", "--color-danger-bg", 4.9],
  ];
  const listed = LISTED.map(([text, fill, ratio]) => ({ text: tokens.get(text), fill: tokens.get(fill), ratio }));

  // [the key of the fill, the key of the text color on it]
  const PAIRS: [string, string][] = [
    ["primaryColor", "primaryTextColor"],
    ["secondaryColor", "secondaryTextColor"],
    ["tertiaryColor", "tertiaryTextColor"],
    ["mainBkg", "nodeTextColor"],
    ["clusterBkg", "titleColor"],
    ["edgeLabelBackground", "textColor"],
    ["background", "textColor"],
    ["noteBkgColor", "noteTextColor"],
    ["actorBkg", "actorTextColor"],
    ["labelBoxBkgColor", "labelTextColor"],
    ["activationBkgColor", "signalTextColor"],
    ["altBackground", "textColor"],
    ["signalColor", "sequenceNumberColor"],
    ["stateBkg", "stateLabelColor"],
    ["compositeBackground", "stateLabelColor"],
    ["compositeTitleBackground", "stateLabelColor"],
    ["errorBkgColor", "errorTextColor"],
    ["attributeBackgroundColorOdd", "textColor"],
    ["attributeBackgroundColorEven", "textColor"],
    ...Array.from({ length: 12 }, (_, i): [string, string] => [`pie${i + 1}`, "pieSectionTextColor"]),
  ];

  it.each(PAIRS)("puts a listed text color on the fill %s (%s)", (fillKey, textKey) => {
    const [fill, text] = [THEME[fillKey], THEME[textKey]];
    const entry = listed.find((pair) => pair.fill === fill && pair.text === text);

    expect(entry, `${textKey} ${text} on ${fillKey} ${fill} is not a pair that the design system lists`).toBeDefined();
    expect(contrast(text as string, fill as string)).toBeGreaterThanOrEqual(4.5);
  });

  it("computes the contrast that the design system lists, to one decimal", () => {
    for (const { text, fill, ratio } of listed) expect(Math.round(contrast(text as string, fill as string) * 10) / 10, `${text} on ${fill}`).toBeCloseTo(ratio, 1);
  });

  it("uses the light theme only, with a white background", () => {
    expect(THEME.darkMode).toBe(false);
    expect(THEME.background).toBe(tokens.get("--color-bg"));
  });
});
