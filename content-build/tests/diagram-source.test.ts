// The checks on the Mermaid text that need no browser: the diagram type, the rules, the limits, and the lines they are reported at.

import { describe, expect, it } from "vitest";
import { validateCourse } from "../src/course.ts";
import {
  DIAGRAM_TYPES,
  MAX_SOURCE_CHARACTERS,
  MAX_SOURCE_LINES,
  diagramSourceProblems,
  diagramType,
  sourceLineOfMermaidLine,
  sourcePosition,
} from "../src/diagram-source.ts";
import { compileLesson } from "../src/lesson.ts";
import { lesson, mermaidCourses } from "./mermaid-helpers.ts";

const messages = (source: string) => diagramSourceProblems(source).map((problem) => problem.message);

describe("the diagram type", () => {
  it("is the first word of the first line that is not blank and not a %% comment", () => {
    expect(diagramType("\n  \n%% a comment\n%%another\n  sequenceDiagram\n A->>B: hi")).toEqual({ type: "sequenceDiagram", line: 5 });
    expect(diagramType("graph TD; A-->B")).toEqual({ type: "graph", line: 1 });
    expect(diagramType("pie showData")).toEqual({ type: "pie", line: 1 });
    expect(diagramType("%% only a comment\n\n")).toBeUndefined();
  });

  it.each(DIAGRAM_TYPES)("accepts %s", (type) => {
    expect(diagramSourceProblems(`${type}\n A --> B`)).toEqual([]);
  });

  it("lists the supported types", () => {
    expect(DIAGRAM_TYPES).toEqual(["flowchart", "graph", "sequenceDiagram", "classDiagram", "stateDiagram", "stateDiagram-v2", "erDiagram", "pie"]);
  });

  it.each(["gantt", "mindmap", "architecture-beta", "zenuml", "journey", "classDiagram-v2", "Flowchart", "flowchart-elk"])("rejects %s, names it, and lists the supported types", (type) => {
    const [message] = messages(`${type}\n A --> B`);

    expect(message).toContain(`\`${type}\``);
    for (const supported of DIAGRAM_TYPES) expect(message).toContain(`\`${supported}\``);
  });

  it("reports an unsupported type at the line of its first line, after blank lines and comments", () => {
    expect(diagramSourceProblems("\n%% note\ngantt\n title x")).toEqual([expect.objectContaining({ line: 3 })]);
  });

  it("reports a source with no diagram at all", () => {
    expect(diagramSourceProblems("  \n%% only a comment")).toEqual([expect.objectContaining({ line: 1, message: expect.stringContaining("no diagram") })]);
  });
});

describe("the rules that are errors before any drawing", () => {
  it("rejects a %%{ directive, at its line (an init directive can switch htmlLabels back on)", () => {
    const problems = diagramSourceProblems("flowchart LR\n A --> B\n%%{init: {\"htmlLabels\": true}}%%");

    expect(problems).toEqual([expect.objectContaining({ line: 3, message: expect.stringContaining("%%{") })]);
  });

  it("allows an ordinary %% comment", () => {
    expect(diagramSourceProblems("flowchart LR\n%% a comment\n A --> B")).toEqual([]);
  });

  it("rejects a first non-blank line of ---, front matter, which can set config", () => {
    const problems = diagramSourceProblems("\n---\nconfig:\n  htmlLabels: true\n---\nflowchart LR\n A --> B");

    expect(problems).toEqual([expect.objectContaining({ line: 2, message: expect.stringContaining("front matter") })]);
  });

  it("does not take --- later in the text for front matter", () => {
    expect(diagramSourceProblems("flowchart LR\n A --- B")).toEqual([]);
  });

  it.each(["click A href \"https://example.com\"", "  click A callback", "A --> B; click A href \"x\"", "CLICK A call f()"])("rejects a click statement: %s", (statement) => {
    const problems = diagramSourceProblems(`flowchart LR\n A --> B\n ${statement}`);

    expect(problems).toEqual([expect.objectContaining({ line: 3, message: expect.stringContaining("click") })]);
  });

  it("does not take a word that merely starts with click, or click inside a quoted label, for a statement", () => {
    expect(diagramSourceProblems("flowchart LR\n clicker --> B\n A[\"a; click here\"] --> B\n C[Please click now] --> B")).toEqual([]);
  });

  it.each([["NUL", "\u0000"], ["a bell", "\u0007"], ["DEL", "\u007f"], ["a C1 control", "\u0085"], ["a vertical tab", "\u000b"]])("rejects %s, at its line", (_name, character) => {
    const problems = diagramSourceProblems(`flowchart LR\n A --> B\n C[a${character}b] --> D`);

    expect(problems).toEqual([expect.objectContaining({ line: 3, message: expect.stringContaining("control character") })]);
  });

  it("allows tab and line breaks", () => {
    expect(diagramSourceProblems("flowchart LR\r\n\tA --> B\r\n\tB --> C")).toEqual([]);
  });

  it("counts CRLF as one character", () => {
    const body = "flowchart LR\r\n";
    const source = body + "x".repeat(MAX_SOURCE_CHARACTERS - body.length + 1);

    expect(normalizedLength(source)).toBe(MAX_SOURCE_CHARACTERS);
    expect(diagramSourceProblems(source)).toEqual([]);
  });
});

function normalizedLength(source: string): number {
  return [...source.replace(/\r\n?/g, "\n")].length;
}

describe("the limits", () => {
  const head = "flowchart LR\n";

  it("passes a source of exactly 5000 characters and fails one more, at the line of the 5001st character", () => {
    const exact = head + "x".repeat(MAX_SOURCE_CHARACTERS - head.length);

    expect(diagramSourceProblems(exact)).toEqual([]);
    expect(diagramSourceProblems(`${exact}x`)).toEqual([expect.objectContaining({ line: 2, message: expect.stringContaining("5001 characters") })]);
  });

  it("counts Unicode characters, not UTF-16 units", () => {
    const exact = head + "😀".repeat(MAX_SOURCE_CHARACTERS - head.length);

    expect(exact.length).toBeGreaterThan(MAX_SOURCE_CHARACTERS);
    expect(diagramSourceProblems(exact)).toEqual([]);
    expect(messages(`${exact}😀`)).toHaveLength(1);
  });

  it("passes a source of exactly 200 lines and fails one more, at line 201", () => {
    const lines = (count: number) => [head.trim(), ...Array.from({ length: count - 1 }, () => " A --> B")].join("\n");

    expect(diagramSourceProblems(lines(MAX_SOURCE_LINES))).toEqual([]);
    expect(diagramSourceProblems(`${lines(MAX_SOURCE_LINES)}\n`)).toEqual([]);
    expect(diagramSourceProblems(lines(MAX_SOURCE_LINES + 1))).toEqual([expect.objectContaining({ line: 201, message: expect.stringContaining("201 lines") })]);
  });

  it("passes exactly 5000 characters in exactly 200 lines", () => {
    const lines = ["flowchart LR", ...Array.from({ length: 199 }, () => "")];
    let source = lines.join("\n");
    source += "x".repeat(MAX_SOURCE_CHARACTERS - source.length);

    expect(source.split("\n")).toHaveLength(200);
    expect(source).toHaveLength(MAX_SOURCE_CHARACTERS);
    expect(diagramSourceProblems(source)).toEqual([]);
    expect(diagramSourceProblems(`${source}\nx`)).not.toEqual([]);
  });
});

describe("the position in the lesson", () => {
  it("is the prop's line plus the line in the source minus 1, with the prop's column for the first line and 1 for the later ones", () => {
    expect(sourcePosition({ line: 10, column: 7 }, 1)).toEqual({ line: 10, column: 7 });
    expect(sourcePosition({ line: 10, column: 7 }, 4)).toEqual({ line: 13, column: 1 });
  });

  it("is where `validate` reports a problem of the source (found without any browser)", () => {
    const courses = mermaidCourses({
      "chapters/01-diagram-types/lessons/01-types.mdx": lesson(
        ["text", "", "<Diagram", '  alt="x"', '  source="flowchart LR', "    A --> B", '    click A href &quot;https://example.com&quot;"', "/>"].join("\n"),
      ),
    });

    const problems = validateCourse(`${courses}/mermaid-course`);

    expect(problems).toEqual([
      expect.objectContaining({
        file: "chapters/01-diagram-types/lessons/01-types.mdx",
        severity: "error",
        line: 12,
        column: 1,
        message: expect.stringContaining("`click` statement"),
      }),
    ]);
  });

  it("puts the first source line at the column of the prop", () => {
    const text = lesson('<Diagram alt="x" source="gantt\n  title t" />');
    const problems = validateCourse(`${mermaidCourses({ "chapters/01-diagram-types/lessons/01-types.mdx": text })}/mermaid-course`);

    expect(problems).toEqual([expect.objectContaining({ line: 6, column: 18, message: expect.stringContaining("`gantt`") })]);
  });
});

describe("compileLesson and the Diagram uses", () => {
  const text = lesson(['<Diagram alt="Flow" source="graph TD', "  A --> B\" />", "", '<Diagram src="a.svg" alt="File" />', "", '<Diagram', '  source="pie', '  &quot;a&quot; : 1"', '  alt="Pie"', "/>"].join("\n"));

  it("returns the source, alt, and position of the prop and of the tag of every Diagram that has a source, next to the tree", () => {
    const result = compileLesson(text, { path: "x.mdx" });
    if ("problems" in result) throw new Error(JSON.stringify(result.problems));

    expect(result.diagrams).toEqual([
      { source: "graph TD\nA --> B", alt: "Flow", line: 6, column: 21, tagLine: 6, tagColumn: 1 },
      { source: 'pie\n"a" : 1', alt: "Pie", line: 12, column: 3, tagLine: 11, tagColumn: 1 },
    ]);
  });

  it("keeps source as written in the tree, so the trees of the earlier steps do not change", () => {
    const result = compileLesson(text, { path: "x.mdx" });
    if ("problems" in result) throw new Error("did not compile");
    const diagrams = result.tree.children.filter((node) => node.type === "component" && node.name === "Diagram");

    expect(diagrams.map((node) => (node.type === "component" ? node.props : undefined))).toEqual([
      { alt: "Flow", source: "graph TD\nA --> B" },
      { alt: "File", src: "a.svg" },
      { alt: "Pie", source: 'pie\n"a" : 1' },
    ]);
  });

  it("removes the spaces at the start of every line of the prop, so indentation cannot carry meaning", () => {
    const result = compileLesson(lesson('<Diagram alt="x" source="flowchart LR\n        A --> B\n\t\tB --> C" />'), { path: "x.mdx" });
    if ("problems" in result) throw new Error("did not compile");

    expect(result.diagrams[0]?.source).toBe("flowchart LR\nA --> B\nB --> C");
  });

  it("returns no uses for a lesson with only src", () => {
    const result = compileLesson(lesson('<Diagram src="a.svg" alt="File" />'), { path: "x.mdx" });
    if ("problems" in result) throw new Error("did not compile");

    expect(result.diagrams).toEqual([]);
  });
});

describe("the line that Mermaid names", () => {
  it("is counted after the leading blank lines and every comment line are gone, and is mapped back to the line of the source", () => {
    const source = "\n\n%% a\nflowchart LR\n A --> B\n%% c\n C --> D\n E -->\n";

    // Mermaid sees "flowchart LR / A --> B / C --> D / E -->".
    expect(sourceLineOfMermaidLine(source, 1)).toBe(4);
    expect(sourceLineOfMermaidLine(source, 2)).toBe(5);
    expect(sourceLineOfMermaidLine(source, 3)).toBe(7);
    expect(sourceLineOfMermaidLine(source, 4)).toBe(8);
  });

  it("is the same line when there is nothing to remove", () => {
    expect(sourceLineOfMermaidLine("pie\n a\n b", 3)).toBe(3);
  });

  it("counts a blank line before a comment as part of the comment", () => {
    expect(sourceLineOfMermaidLine("graph TD\n\n%% c\nA --> B", 2)).toBe(4);
  });

  it("gives the last line for a number past the end", () => {
    expect(sourceLineOfMermaidLine("graph TD\nA --> B", 9)).toBe(2);
  });
});
