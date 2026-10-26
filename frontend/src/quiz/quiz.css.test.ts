import { describe, expect, it } from "vitest";
import css from "./quiz.css?raw";

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

describe("quiz.css", () => {
  it("makes each radio row at least 44px high", () => {
    expect(rule(".quiz-option")).toMatch(/min-height:\s*44px/);
  });

  it("wraps long unbroken text instead of widening the page", () => {
    expect(rule(".quiz-region")).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("lets a code snippet scroll inside its own box and keeps its whitespace", () => {
    expect(rule(".quiz-snippet")).toMatch(/overflow-x:\s*auto/);
    expect(rule(".quiz-snippet")).toMatch(/max-width:\s*100%/);
    expect(rule(".quiz-snippet code")).toMatch(/white-space:\s*pre\b/);
  });

  it("keeps the snippet on the surface background and the text color, and no part of it unselectable", () => {
    expect(rule(".quiz-snippet")).toMatch(/background:\s*var\(--color-surface\)/);
    expect(rule(".quiz-snippet")).toMatch(/color:\s*var\(--color-text\)/);
    expect(rule(".quiz-snippet")).not.toMatch(/user-select/);
    expect(rule(".quiz-snippet code")).not.toMatch(/user-select/);
  });

  it("shows a tab in a snippet as 4 columns, as the code viewer does", () => {
    expect(rule(".quiz-snippet code")).toMatch(/tab-size:\s*4\b/);
  });

  it("uses no raw color", () => {
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
  });

  it("keeps the question column shrinkable so a wide snippet cannot widen the page", () => {
    expect(rule(".quiz-questions")).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(rule(".quiz-question")).toMatch(/min-width:\s*0/);
  });

  it("colors Correct with the success token and Incorrect with the danger token", () => {
    expect(rule(".quiz-correct")).toMatch(/color:\s*var\(--color-success\)/);
    expect(rule(".quiz-incorrect")).toMatch(/color:\s*var\(--color-danger\)/);
  });

  it("does not animate or scroll smoothly", () => {
    expect(css).not.toMatch(/\b(transition|animation|scroll-behavior)\b/);
  });
});
