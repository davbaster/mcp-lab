import { expect, it } from "vitest";
import tokensCss from "./tokens.css?raw";

// Every value in _docs/design-system.md ("Color", "Typography", "Spacing, size, and shape").
const EXPECTED: Record<string, string> = {
  "--color-bg": "#ffffff",
  "--color-surface": "#f6f7f9",
  "--color-border": "#d0d5dd",
  "--color-border-strong": "#8a94a6",
  "--color-text": "#1d2330",
  "--color-text-muted": "#4a5363",
  "--color-primary": "#1f5fbf",
  "--color-primary-hover": "#174a96",
  "--color-success": "#1a7f37",
  "--color-warning": "#9a6700",
  "--color-danger": "#c62828",
  "--color-tip-bg": "#eaf6ee",
  "--color-warning-bg": "#fff6e0",
  "--color-note-bg": "#eaf1fb",
  "--color-danger-bg": "#fdecec",
  "--color-changed-line": "#fff3c4",
  "--font-text": 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  "--font-code": 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace',
  "--font-size-sm": "14px",
  "--font-size-base": "16px",
  "--font-size-lg": "18px",
  "--font-size-xl": "20px",
  "--font-size-2xl": "24px",
  "--font-size-3xl": "30px",
  "--line-height-body": "1.6",
  "--line-height-heading": "1.25",
  "--line-height-code": "1.5",
  "--space-4": "4px",
  "--space-8": "8px",
  "--space-12": "12px",
  "--space-16": "16px",
  "--space-24": "24px",
  "--space-32": "32px",
  "--space-48": "48px",
  "--space-64": "64px",
  "--radius": "6px",
};

function declaredTokens(css: string): Record<string, string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens: Record<string, string> = {};
  for (const match of withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[match[1]] = match[2].trim();
  }
  return tokens;
}

const declared = declaredTokens(tokensCss);

it.each(Object.entries(EXPECTED))("tokens.css declares %s as %s", (name, value) => {
  expect(declared[name]).toBe(value);
});

it("tokens.css declares no token that the design system does not list", () => {
  expect(Object.keys(declared).sort()).toEqual(Object.keys(EXPECTED).sort());
});

it("no CSS file other than tokens.css has a hex color, rgb( or hsl(", () => {
  const files = import.meta.glob<string>("../**/*.css", { query: "?raw", import: "default", eager: true });
  const others = Object.entries(files).filter(([path]) => !/(^|\/)tokens\.css$/.test(path));

  expect(others.length).toBeGreaterThan(0);
  for (const [path, css] of others) {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(withoutComments, path).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
  }
});

it("no component sets a color, spacing or font size inline", () => {
  const sources = import.meta.glob<string>("../**/*.tsx", { query: "?raw", import: "default", eager: true });

  for (const [path, source] of Object.entries(sources)) {
    if (path.endsWith(".test.tsx") || path.includes("/test/")) continue;
    expect(source, path).not.toMatch(/style=\{\{/);
  }
});
