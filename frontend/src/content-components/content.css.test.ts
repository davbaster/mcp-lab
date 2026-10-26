import { describe, expect, it } from "vitest";
import globalCss from "../styles/global.css?raw";
import css from "./content.css?raw";

const rules = css
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("}")
  .map((chunk) => chunk.split("{"))
  .filter((parts) => parts.length === 2)
  .map(([selectors, body]) => ({ selectors: selectors.split(",").map((selector) => selector.trim()), body }));

/** The declarations of every rule that lists `selector`. jsdom has no layout, so these are read from the CSS. */
function rule(selector: string): string {
  return rules
    .filter((r) => r.selectors.includes(selector))
    .map((r) => r.body)
    .join("\n");
}

describe("content.css", () => {
  it("makes tabs at least 44px high and wide, bold and underlined 3px in the primary color when selected", () => {
    expect(rule(".tab")).toMatch(/min-height:\s*44px/);
    expect(rule(".tab")).toMatch(/min-width:\s*44px/);
    expect(rule('.tab[aria-selected="true"]')).toMatch(/font-weight:\s*700/);
    expect(rule('.tab[aria-selected="true"]')).toMatch(/border-bottom-color:\s*var\(--color-primary\)/);
    expect(rule(".tab")).toMatch(/border-bottom:\s*3px solid/);
  });

  it("lets the tab list and code blocks scroll inside themselves", () => {
    expect(rule(".tablist")).toMatch(/overflow-x:\s*auto/);
    expect(rule(".lesson-content pre")).toMatch(/overflow-x:\s*auto/);
  });

  it("keeps the text column at 72ch and lets only a diagram span the full width", () => {
    expect(rule(".lesson-content")).toMatch(/grid-template-columns:\s*minmax\(0,\s*72ch\)\s+minmax\(0,\s*1fr\)/);
    expect(rule(".lesson-content > *")).toMatch(/grid-column:\s*1\b/);
    expect(rule(".lesson-content > .diagram")).toMatch(/grid-column:\s*1\s*\/\s*-1/);
  });

  it("scales images down and keeps their proportions", () => {
    expect(rule(".lesson-image")).toMatch(/max-width:\s*100%/);
    expect(rule(".lesson-image")).toMatch(/height:\s*auto/);
  });

  it("gives each callout a 4px left border in its label color, on the background token", () => {
    expect(rule(".callout")).toMatch(/border-left:\s*4px solid var\(--callout-color\)/);
    expect(rule(".callout-tip")).toMatch(/--callout-bg:\s*var\(--color-tip-bg\)[^]*--callout-color:\s*var\(--color-success\)/);
    expect(rule(".callout-warning")).toMatch(/--callout-bg:\s*var\(--color-warning-bg\)[^]*--callout-color:\s*var\(--color-warning\)/);
    expect(rule(".callout")).toMatch(/--callout-bg:\s*var\(--color-note-bg\)[^]*--callout-color:\s*var\(--color-primary\)/);
  });

  it("does not animate anything", () => {
    expect(css).not.toMatch(/\b(transition|animation|scroll-behavior)\b/);
  });

  it("has no raw color in the code viewer's CSS (the colors are tokens)", () => {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(withoutComments).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
  });
});

describe("content.css, the code viewer", () => {
  it("lets the code viewer span the full content width, like a diagram, and never grow wider than it", () => {
    expect(rule(".lesson-content > .code-steps")).toMatch(/grid-column:\s*1\s*\/\s*-1/);
    expect(rule(".code-steps")).toMatch(/max-width:\s*100%/);
  });

  it("reserves room for the loading box with a min-height", () => {
    expect(rule(".code-steps-loading")).toMatch(/min-height:\s*\d+px/);
  });

  it("draws the code area in the surface color, the code font, the radius, 16px padding and the code line height", () => {
    const area = rule(".code-area");
    expect(area).toMatch(/background:\s*var\(--color-surface\)/);
    expect(area).toMatch(/font-family:\s*var\(--font-code\)/);
    expect(area).toMatch(/border-radius:\s*var\(--radius\)/);
    expect(area).toMatch(/padding:\s*var\(--space-16\)/);
    expect(area).toMatch(/line-height:\s*var\(--line-height-code\)/);
    expect(area).toMatch(/color:\s*var\(--color-text\)/);
  });

  it("scrolls long lines sideways inside the code area and never wraps them", () => {
    expect(rule(".code-area")).toMatch(/overflow-x:\s*auto/);
    expect(rule(".code-steps .code-line-text")).toMatch(/white-space:\s*pre\b/);
    expect(rule(".code-steps .code-line-text")).not.toMatch(/white-space:\s*(normal|pre-wrap|pre-line)/);
    expect(rule(".code-steps .tab")).toMatch(/white-space:\s*nowrap/);
    expect(rule(".code-steps .tab")).toMatch(/max-width:\s*none/);
  });

  it("draws line numbers in the muted text color and keeps them out of a selection", () => {
    expect(rule(".code-line-number")).toMatch(/color:\s*var\(--color-text-muted\)/);
    expect(rule(".code-line-number")).toMatch(/user-select:\s*none/);
  });

  it("undoes the look of inline code for the code of a line", () => {
    const line = rule(".code-steps .code-line-text");
    expect(line).toMatch(/padding:\s*0/);
    expect(line).toMatch(/background:\s*none/);
    expect(line).toMatch(/font-size:\s*inherit/);
  });

  it("colors each token class from its own token", () => {
    for (const name of ["comment", "constant", "keyword", "parameter", "function", "string", "string-expression", "punctuation", "link"]) {
      expect(rule(`.code-token-${name}`)).toMatch(new RegExp(`color:\\s*var\\(--color-code-${name}\\)`));
    }
  });

  it("hides text from sight but not from screen readers", () => {
    const hidden = rule(".visually-hidden");
    expect(hidden).toMatch(/position:\s*absolute/);
    expect(hidden).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(hidden).not.toMatch(/display:\s*none|visibility:\s*hidden/);
  });

  it("makes the Copy button (a .button) at least 44px high and wide", () => {
    const button = globalCss
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .match(/\.button\s*\{([^}]*)\}/)?.[1];
    expect(button).toMatch(/min-height:\s*44px/);
    expect(button).toMatch(/min-width:\s*44px/);
  });
});

describe("content.css, videos and 3D models", () => {
  it("gives the frame a 16:9 ratio that never grows wider than the content", () => {
    const frame = rule(".media-frame");
    expect(frame).toMatch(/aspect-ratio:\s*16\s*\/\s*9/);
    expect(frame).toMatch(/width:\s*100%/);
    expect(frame).toMatch(/max-width:\s*100%/);
    expect(rule(".video")).toMatch(/max-width:\s*100%/);
    expect(rule(".model3d")).toMatch(/max-width:\s*100%/);
  });

  it("lets a video and a model span the full content width, like a diagram", () => {
    expect(rule(".lesson-content > .video")).toMatch(/grid-column:\s*1\s*\/\s*-1/);
    expect(rule(".lesson-content > .model3d")).toMatch(/grid-column:\s*1\s*\/\s*-1/);
  });

  it("fills the frame with the video, the iframe, the viewer and the poster", () => {
    expect(rule(".media-frame video")).toMatch(/width:\s*100%[^]*height:\s*100%/);
    expect(rule(".media-frame iframe")).toMatch(/width:\s*100%[^]*height:\s*100%/);
    expect(rule(".model-viewer")).toMatch(/position:\s*absolute[^]*inset:\s*0/);
    expect(rule(".model-poster")).toMatch(/object-fit:\s*contain/);
  });

  it("draws the frame and the poster from tokens only", () => {
    expect(rule(".media-frame")).toMatch(/background:\s*var\(--color-surface\)/);
    expect(rule(".media-frame")).toMatch(/border-radius:\s*var\(--radius\)/);
    expect(rule(".model-poster")).toMatch(/background:\s*var\(--color-surface\)/);
    expect(rule(".model-note")).toMatch(/color:\s*var\(--color-text-muted\)/);
  });

  it("draws the design system's focus ring on the viewer, inside the frame", () => {
    const ring = rule(".model-viewer:focus-within");
    expect(ring).toMatch(/outline:\s*3px solid var\(--color-primary\)/);
    expect(ring).toMatch(/outline-offset:\s*-3px/);
  });

  it("keeps the load button inside the frame, and the Load 3D model button is a .button (44px high and wide)", () => {
    expect(rule(".model-load")).toMatch(/position:\s*absolute/);
    expect(rule(".model-load")).toMatch(/max-width:\s*calc\(100%/);
    expect(rule(".model-load")).not.toMatch(/\b(width|height):\s*\d+px/);
  });
});
