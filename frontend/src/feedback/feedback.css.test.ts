import { describe, expect, it } from "vitest";
import dockerfile from "../../Dockerfile?raw";
import css from "./feedback.css?raw";

const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the rules for `selector`, inside the media query `media` (or outside any). jsdom has no layout, so these are read from the CSS. */
function declarations(selector: string, media: string | null = null): string {
  const scope = media === null ? stripped.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, "") : mediaBlock(media);
  const found: string[] = [];
  for (const match of scope.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    if (match[1].split(",").some((s) => s.trim() === selector)) found.push(match[2]);
  }
  return found.join("\n");
}

function mediaBlock(query: string): string {
  const start = stripped.indexOf(`@media (${query})`);
  if (start === -1) return "";
  const open = stripped.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < stripped.length; index += 1) {
    if (stripped[index] === "{") depth += 1;
    if (stripped[index] === "}" && --depth === 0) return stripped.slice(open + 1, index);
  }
  return "";
}

describe("feedback.css: the dialog", () => {
  it("fills the screen below 480px", () => {
    const base = declarations(".feedback-dialog");

    // Anchored: `width` must not match inside `max-width`, nor `height` inside `max-height`.
    expect(base).toMatch(/(?<![-\w])width:\s*100%/);
    expect(base).toMatch(/(?<![-\w])height:\s*100%/);
    expect(base).toMatch(/max-width:\s*100%/);
    expect(base).toMatch(/max-height:\s*100%/);
    expect(base).toMatch(/border-radius:\s*0/);
  });

  it("is a centred box of at most 560px from 480px", () => {
    const wide = declarations(".feedback-dialog", "min-width: 480px");

    expect(wide).toMatch(/width:\s*560px/);
    expect(wide).toMatch(/max-width:\s*calc\(/);
    expect(wide).toMatch(/margin:\s*auto/);
    expect(wide).toMatch(/height:\s*auto/);
  });

  it("scrolls inside itself and keeps the page still", () => {
    expect(declarations(".feedback-dialog")).toMatch(/overflow-y:\s*auto/);
    expect(stripped).toMatch(/body:has\(\.feedback-dialog\[open\]\)\s*\{[^}]*overflow:\s*hidden/);
  });

  it("uses an existing token with reduced opacity for the backdrop", () => {
    const backdrop = declarations(".feedback-dialog::backdrop");

    expect(backdrop).toMatch(/background:\s*var\(--color-text\)/);
    expect(backdrop).toMatch(/opacity:\s*0?\.\d+/);
  });

  it("makes each radio and checkbox row at least 44px high", () => {
    expect(declarations(".feedback-choice")).toMatch(/min-height:\s*44px/);
  });

  it("has no raw color, no animation, and no tokens it does not use from tokens.css", () => {
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
    expect(stripped).not.toMatch(/\b(transition|animation|scroll-behavior)\b/);
    for (const [, name] of stripped.matchAll(/var\((--[\w-]+)\)/g)) expect(name).toMatch(/^--(color|space|radius|font)/);
  });
});

describe("frontend/Dockerfile", () => {
  it("takes VITE_APP_VERSION as a build argument that defaults to dev, in the build stage", () => {
    const build = dockerfile.split(/^FROM /m)[1];

    expect(build).toMatch(/^ARG VITE_APP_VERSION=dev$/m);
    expect(build).toMatch(/^ENV VITE_APP_VERSION=\$VITE_APP_VERSION$/m);
  });

  it("sets it after COPY frontend ./ and before the build, so the npm ci layer stays cached", () => {
    const lines = dockerfile.split("\n");
    const at = (pattern: RegExp) => lines.findIndex((line) => pattern.test(line));

    expect(at(/^RUN npm ci$/)).toBeLessThan(at(/^COPY frontend \.\/$/));
    expect(at(/^COPY frontend \.\/$/)).toBeLessThan(at(/^ARG VITE_APP_VERSION=dev$/));
    expect(at(/^ARG VITE_APP_VERSION=dev$/)).toBeLessThan(at(/^ENV VITE_APP_VERSION=/));
    expect(at(/^ENV VITE_APP_VERSION=/)).toBeLessThan(at(/^RUN npm run build$/));
  });
});
