// @vitest-environment node
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Lints a snippet with the repo's own ESLint config, as if it were a file in the renderer.
const root = new URL("../../", import.meta.url).pathname;
const eslint = new ESLint({ cwd: root });

async function messages(code: string, filePath = "src/content-components/Snippet.tsx") {
  const [result] = await eslint.lintText(code, { filePath: `${root}${filePath}` });
  return result.messages.filter((m) => m.ruleId === "no-restricted-syntax").map((m) => m.message);
}

const snippets: [string, string][] = [
  ["dangerouslySetInnerHTML as a JSX attribute", "export const A = () => <div dangerouslySetInnerHTML={{ __html: 'x' }} />;"],
  ["dangerouslySetInnerHTML as an object key", "export const props = { dangerouslySetInnerHTML: { __html: 'x' } };"],
  ["dangerouslySetInnerHTML as a quoted key", "export const props = { 'dangerouslySetInnerHTML': { __html: 'x' } };"],
  ["innerHTML", "export function f(el: HTMLElement) { el.innerHTML = 'x'; }"],
  ["innerHTML read", "export const f = (el: HTMLElement) => el.innerHTML;"],
  ["a computed innerHTML", "export function f(el: HTMLElement) { el['innerHTML'] = 'x'; }"],
  ["outerHTML", "export function f(el: HTMLElement) { el.outerHTML = 'x'; }"],
  ["insertAdjacentHTML", "export function f(el: HTMLElement) { el.insertAdjacentHTML('beforeend', 'x'); }"],
  ["document.write", "export function f() { document.write('x'); }"],
  ["document.writeln", "export function f() { document.writeln('x'); }"],
  ["window.document.write", "export function f() { window.document.write('x'); }"],
  ["globalThis.document.write", "export function f() { globalThis.document.write('x'); }"],
  ["a computed document['write']", "export function f() { document['write']('x'); }"],
  ["a template-literal document[`write`]", "export function f() { document[`write`]('x'); }"],
  ["a template-literal el[`innerHTML`]", "export function f(el: HTMLElement) { el[`innerHTML`] = 'x'; }"],
  ["a quoted el['innerHTML']", "export const f = (el: HTMLElement) => el['innerHTML'];"],
  ["setHTMLUnsafe", "export function f(el: HTMLElement) { (el as any).setHTMLUnsafe('x'); }"],
  ["parseHTMLUnsafe", "export const f = () => (Document as any).parseHTMLUnsafe('x');"],
  ["createContextualFragment", "export const f = (r: Range) => r.createContextualFragment('x');"],
  ["new DOMParser", "export const f = () => new DOMParser().parseFromString('x', 'text/html');"],
  ["new window.DOMParser", "export const f = () => new window.DOMParser();"],
  ["a destructured innerHTML", "export const f = (el: HTMLElement) => { const { innerHTML } = el; return innerHTML; };"],
];

describe("the no-HTML rule in the renderer", () => {
  it.each(snippets)("reports an error for %s", async (_name, code) => {
    const found = await messages(code);
    expect(found.length).toBeGreaterThan(0);
    expect(found.join(" ")).toContain("Author text is rendered as text only");
  });

  it("applies in the lesson page too", async () => {
    expect((await messages(snippets[3][1], "src/pages/LessonPage.tsx")).length).toBeGreaterThan(0);
  });

  it("applies in a nested folder of the renderer", async () => {
    expect((await messages(snippets[0][1], "src/content-components/deep/Snippet.tsx")).length).toBeGreaterThan(0);
  });

  it("applies in the quiz page and the quiz folder", async () => {
    expect((await messages(snippets[3][1], "src/pages/QuizPage.tsx")).length).toBeGreaterThan(0);
    expect((await messages(snippets[0][1], "src/quiz/Snippet.tsx")).length).toBeGreaterThan(0);
    expect((await messages(snippets[8][1], "src/quiz/deep/Snippet.ts")).length).toBeGreaterThan(0);
  });

  it("does not apply to the quiz tests, which read the rendered HTML", async () => {
    expect(await messages(snippets[3][1], "src/pages/QuizPage.test.tsx")).toEqual([]);
    expect(await messages(snippets[3][1], "src/quiz/Snippet.test.tsx")).toEqual([]);
  });

  it("still bans fetch there (the existing rule list is kept)", async () => {
    const found = await messages("export const f = () => globalThis.fetch('/x');");
    expect(found.join(" ")).toContain("Use the generated API client");
  });

  it("reports nothing for ordinary rendering code", async () => {
    expect(await messages("export const A = ({ t }: { t: string }) => <p title={t}>{t}</p>;")).toEqual([]);
  });

  it("does not apply the HTML rule outside those paths", async () => {
    expect(await messages(snippets[3][1], "src/components/Snippet.tsx")).toEqual([]);
  });
});
