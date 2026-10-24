// The SVG rules: a text scan with no XML parser. One fixture file per rule and per evasion.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { svgProblems } from "../src/svg.ts";
import { FIXTURES } from "./helpers.ts";

const SVG_FIXTURES = join(FIXTURES, "svg");
const read = (group: string, name: string) => readFileSync(join(SVG_FIXTURES, group, `${name}.svg`), "utf8");

/** Each invalid fixture: the line of the first match, and what the one message says. */
const INVALID: Record<string, { line: number; message: RegExp }> = {
  "no-svg-tag": { line: 1, message: /no `<svg` start tag/ },
  "encoding-latin1": { line: 1, message: /encoding is `ISO-8859-1`; an SVG must be UTF-8/ },
  "encoding-single-quotes": { line: 1, message: /encoding is `UTF-16`; an SVG must be UTF-8/ },
  script: { line: 3, message: /`<script>` element/ },
  "script-twice": { line: 3, message: /`<script>` element/ },
  "script-prefixed": { line: 3, message: /`<script>` element/ },
  "script-uppercase": { line: 3, message: /`<SCRIPT>` element/ },
  foreignobject: { line: 3, message: /`<foreignObject>` element/ },
  iframe: { line: 3, message: /`<iframe>` element/ },
  embed: { line: 3, message: /`<embed>` element/ },
  object: { line: 3, message: /`<object>` element/ },
  animate: { line: 3, message: /`<animate>` element/ },
  "animate-prefixed": { line: 3, message: /`<animate>` element/ },
  set: { line: 3, message: /`<set>` element/ },
  onload: { line: 1, message: /event-handler attribute `onload`/ },
  "onload-slash": { line: 1, message: /event-handler attribute `onload`/ },
  "onload-after-quote": { line: 1, message: /event-handler attribute `onload`/ },
  "onclick-mixed-case": { line: 3, message: /event-handler attribute `OnClick`/ },
  "onclick-spaced": { line: 3, message: /event-handler attribute `onclick`/ },
  "href-http": { line: 3, message: /`href` attribute and its value does not start with `#`/ },
  "href-xlink-https": { line: 3, message: /`xlink:href` attribute and its value does not start with `#`/ },
  "href-javascript": { line: 3, message: /`href` attribute and its value does not start with `#`/ },
  "href-data": { line: 3, message: /`href` attribute and its value does not start with `#`/ },
  "href-entity": { line: 3, message: /`href` attribute and its value does not start with `#`/ },
  "href-relative": { line: 3, message: /`xlink:href` attribute and its value does not start with `#`/ },
  "href-unquoted": { line: 3, message: /`href` attribute and its value is not in quotes/ },
  "href-spaced": { line: 3, message: /`href` attribute and its value does not start with `#`/ },
  "href-prefix-uppercase": { line: 3, message: /`foo:HREF` attribute and its value does not start with `#`/ },
  "doctype-empty-subset": { line: 2, message: /DOCTYPE with an internal subset/ },
  "doctype-attlist-onload": { line: 2, message: /DOCTYPE with an internal subset/ },
  "doctype-attlist-href": { line: 2, message: /DOCTYPE with an internal subset/ },
  entity: { line: 3, message: /declares an entity \(`<!ENTITY`\)/ },
  "stylesheet-instruction": { line: 2, message: /`<\?xml-stylesheet` instruction/ },
  import: { line: 3, message: /uses `@import`/ },
  "url-external": { line: 3, message: /`url\(` that does not point to `#id`/ },
  "url-quoted-external": { line: 3, message: /`url\(` that does not point to `#id`/ },
  "url-relative": { line: 3, message: /`url\(` that does not point to `#id`/ },
};

describe("the SVG fixtures", () => {
  it("has an expectation for every invalid fixture and a fixture for every expectation", () => {
    const names = readdirSync(join(SVG_FIXTURES, "invalid")).map((name) => name.replace(/\.svg$/, ""));

    expect(names.sort()).toEqual(Object.keys(INVALID).sort());
  });

  it("accepts a clean SVG with <use href>, <style> with url(#id), a gradient, a DOCTYPE without a subset, and a mixed-case HREF", () => {
    expect(svgProblems(read("valid", "clean"))).toEqual([]);
  });

  it.each(Object.entries(INVALID))("rejects %s once, at the line of its first match", (name, { line, message }) => {
    const problems = svgProblems(read("invalid", name)).filter((problem) => message.test(problem.message));

    expect(problems).toHaveLength(1);
    expect(problems[0]?.line).toBe(line);
  });

  it("reports a rule once per file even when it matches twice, at the first match", () => {
    const problems = svgProblems(read("invalid", "script-twice"));

    expect(problems).toHaveLength(1);
    expect(problems[0]?.line).toBe(3);
  });

  it("gives exactly one problem for the fixtures that break one rule only", () => {
    // stylesheet-instruction also has an href in the instruction, and entity declares its entity inside a DOCTYPE
    // subset; each of these breaks a second rule.
    for (const name of Object.keys(INVALID).filter((n) => n !== "stylesheet-instruction" && n !== "entity")) {
      expect(svgProblems(read("invalid", name)), name).toHaveLength(1);
    }
  });
});

describe("svgProblems", () => {
  const svg = (inner: string, attributes = "") => `<svg xmlns="http://www.w3.org/2000/svg"${attributes}>\n${inner}\n</svg>\n`;

  it.each(["script", "foreignObject", "iframe", "embed", "object", "animate", "set"])("rejects <%s> in any letter case, with or without a prefix", (name) => {
    for (const written of [name, name.toUpperCase(), name.toLowerCase(), `svg:${name}`, `X:${name.toUpperCase()}`]) {
      expect(svgProblems(svg(`<${written} />`)), written).toHaveLength(1);
    }
  });

  it.each(["animateTransform", "animateMotion", "setting", "scripted", "objects", "embedded"])("does not reject the element <%s>, which only starts like a rejected one", (name) => {
    expect(svgProblems(svg(`<${name} />`))).toEqual([]);
  });

  it.each([
    ['<rect onclick="x"/>', 1],
    ["<rect\nOnMouseOver='x'/>", 1],
    ['<svg/onload="x">', 1],
    ['<rect a="b"onfocus="x"/>', 1],
    ['<rect data-on="x" font-family="a" notes="b"/>', 0],
    ['<text>Click on the box</text>', 0],
    ['<text>on = off</text>', 0],
  ])("looks for an attribute that starts with on in %j: %i problems", (inner, count) => {
    expect(svgProblems(svg(inner))).toHaveLength(count);
  });

  it.each([
    ['<use href="#a"/>', 0],
    ["<use xlink:href='#a'/>", 0],
    ['<use  HREF  =  "#a"/>', 0],
    ['<use href="#"/>', 0],
    ['<a href="https://example.com/"/>', 1],
    ['<a href="mailto:a@example.com"/>', 1],
    ['<a href=""/>', 1],
    ['<a href=" #a"/>', 1],
    ["<a href=#a/>", 1],
    ['<a\nhref\n=\n"x"/>', 1],
    ['<a xlink:href="//example.com/x"/>', 1],
  ])("checks the value of an href in %j: %i problems", (inner, count) => {
    expect(svgProblems(svg(inner))).toHaveLength(count);
  });

  it.each([
    ["<style>.a{fill:url(#g)}</style>", 0],
    ["<style>.a{fill:url( #g )}</style>", 0],
    ['<style>.a{fill:url("#g")}</style>', 0],
    ["<style>.a{fill:url( '#g' )}</style>", 0],
    ['<rect style="fill:url(#g);stroke:url(#h)"/>', 0],
    ["<style>.a{fill:url(#g);stroke:url(x.svg#h)}</style>", 1],
    ["<style>.a{background:url(data:image/png;base64,AAAA)}</style>", 1],
    ['<style>.a{background:url("x.png")}</style>', 1],
    ["<style>.a{background:url()}</style>", 1],
    ["<style>@IMPORT 'x.css';</style>", 1],
  ])("checks url( and @import in %j: %i problems", (inner, count) => {
    expect(svgProblems(svg(inner))).toHaveLength(count);
  });

  it("scans comments and CDATA too, so it may reject a harmless file", () => {
    expect(svgProblems(svg("<!-- <script>x</script> -->"))).toHaveLength(1);
    expect(svgProblems(svg("<![CDATA[ <iframe/> ]]>"))).toHaveLength(1);
  });

  it("rejects a NUL character and an XML declaration with another encoding, but allows UTF-8 in any case", () => {
    expect(svgProblems(`<svg xmlns="http://www.w3.org/2000/svg">\u0000</svg>`)).toHaveLength(1);
    expect(svgProblems(`<?xml version="1.0" encoding="utf-8"?>${svg("")}`)).toEqual([]);
    expect(svgProblems(`<?xml version="1.0" encoding="Utf-8" standalone="no"?>${svg("")}`)).toEqual([]);
    expect(svgProblems(`<?xml version="1.0" encoding = 'windows-1252'?>${svg("")}`)).toHaveLength(1);
  });

  it("finds an <svg start tag with a prefix or in capital letters, and not just the text svg", () => {
    expect(svgProblems('<SVG xmlns="http://www.w3.org/2000/svg"></SVG>')).toEqual([]);
    expect(svgProblems('<s:svg xmlns:s="http://www.w3.org/2000/svg"></s:svg>')).toEqual([]);
    expect(svgProblems("<svgx></svgx> svg")).toHaveLength(1);
  });

  it("accepts a plain DOCTYPE, and rejects an ENTITY inside a subset in any letter case", () => {
    const doctype = '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n';
    expect(svgProblems(doctype + svg(""))).toEqual([]);
    const problems = svgProblems(`<!DOCTYPE svg [<!entity x "y">]>\n${svg("")}`);

    expect(problems.map((problem) => problem.message)).toEqual([
      expect.stringContaining("DOCTYPE with an internal subset"),
      expect.stringContaining("declares an entity"),
    ]);
  });

  it("rejects a DOCTYPE with an internal subset in any letter case, spacing, or quoting, once per file", () => {
    const body = svg("");
    for (const doctype of [
      "<!DOCTYPE svg []>",
      "<!doctype svg [ ]>",
      "<!DOCTYPE\n  svg\n  [\n]>",
      "<!DOCTYPE[]>",
      '<!DOCTYPE svg SYSTEM "a>b.dtd" [ ]>',
      "<!DOCTYPE svg SYSTEM 'a>b.dtd' [ ]>",
      '<!DOCTYPE svg [ <!ATTLIST svg onload CDATA "alert(1)"> ]>',
      '<!DOCTYPE svg [ <!ATTLIST use href CDATA "https://evil.example/x.svg#a"> ]>',
      '<!DOCTYPE svg [ <!ATTLIST svg onload CDATA "a"> ]>\n<!DOCTYPE svg [ ]>',
    ]) {
      const problems = svgProblems(`${doctype}\n${body}`);

      expect(problems, doctype).toHaveLength(1);
      expect(problems[0]?.message, doctype).toMatch(/DOCTYPE with an internal subset/);
      expect(problems[0]?.line, doctype).toBe(1);
    }
  });

  it("reports the DOCTYPE subset on the line of its first match", () => {
    const problems = svgProblems(`<?xml version="1.0"?>\n\n<!DOCTYPE svg [ ]>\n${svg("")}`);

    expect(problems.map((problem) => problem.line)).toEqual([3]);
  });

  it("does not take a later [ for a DOCTYPE subset", () => {
    const doctype = '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n';

    expect(svgProblems(doctype + svg("<style><![CDATA[ a[b] { fill: red } ]]></style>"))).toEqual([]);
    expect(svgProblems(`<!DOCTYPE svg PUBLIC "a[b" "c">\n${svg("")}`)).toEqual([]);
  });

  it("returns the problems in line order", () => {
    const problems = svgProblems(svg('<script/>\n<a href="x"/>\n<style>@import "a";</style>'));

    expect(problems.map((problem) => problem.line)).toEqual([2, 3, 4]);
  });
});
