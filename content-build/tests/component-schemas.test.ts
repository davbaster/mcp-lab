// The component props schemas in frontend/src/content-components/schemas/, and the loader that reads a schema folder.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SCHEMA_DIR, SetupError, loadComponentSchemas } from "../src/component-schemas.ts";
import { compileLesson } from "../src/lesson.ts";
import { COMPONENT_FIXTURES, PART_DIR, REAL_SCHEMAS, lessonProblem, temporaryFolder } from "./helpers.ts";

type Schema = {
  $schema?: string;
  type?: string;
  required?: string[];
  additionalProperties?: unknown;
  properties?: Record<string, { type?: string; enum?: string[]; pattern?: string; minLength?: number; "x-kind"?: string }>;
  oneOf?: unknown;
  "x-children"?: unknown;
  "x-nested"?: Record<string, Schema>;
};

const FILES = ["CodeSteps", "Callout", "Diagram", "Image", "Model3D", "Tabs", "Video"].map((name) => `${name}.schema.json`).sort();

function read(name: string): Schema {
  return JSON.parse(readFileSync(join(REAL_SCHEMAS, `${name}.schema.json`), "utf8")) as Schema;
}

describe("the real schema folder", () => {
  it("holds exactly the seven schemas of the plan's component table, and nothing else", () => {
    expect(readdirSync(REAL_SCHEMAS).sort()).toEqual(FILES);
  });

  it("is the folder the compiler uses by default, found from the compiler and not from the working folder", () => {
    expect(isAbsolute(DEFAULT_SCHEMA_DIR)).toBe(true);
    expect(resolve(DEFAULT_SCHEMA_DIR)).toBe(resolve(REAL_SCHEMAS));
    expect(resolve(DEFAULT_SCHEMA_DIR)).toBe(resolve(PART_DIR, "..", "frontend", "src", "content-components", "schemas"));
  });

  it("loads, and lists the components by name", () => {
    expect([...loadComponentSchemas(REAL_SCHEMAS).keys()]).toEqual(["Callout", "CodeSteps", "Diagram", "Image", "Model3D", "Tabs", "Video"]);
  });

  describe.each(FILES.map((file) => file.replace(".schema.json", "")))("%s.schema.json", (name) => {
    const schema = read(name);

    it("is a draft-07 JSON Schema for the props object", () => {
      expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(Array.isArray(schema.required)).toBe(true);
      expect(typeof schema.properties).toBe("object");
    });

    it("gives every prop the type string or boolean, as authors can only write a string or a bare attribute", () => {
      for (const [prop, definition] of Object.entries(schema.properties ?? {})) {
        expect(["string", "boolean"], `${name}.${prop}`).toContain(definition.type);
      }
    });

    it("lists only props that exist as required", () => {
      for (const prop of schema.required ?? []) expect(Object.keys(schema.properties ?? {}), prop).toContain(prop);
    });

    it("makes a required text prop minLength 1, so an empty one fails", () => {
      for (const prop of schema.required ?? []) {
        const definition = schema.properties?.[prop];
        if (definition?.type === "string" && definition.enum === undefined && definition.pattern === undefined) {
          expect(definition.minLength, `${name}.${prop}`).toBe(1);
        }
      }
    });

    it("annotates a URL prop with x-kind url, and nothing else with it", () => {
      for (const definition of Object.values(schema.properties ?? {})) {
        if (definition["x-kind"] !== undefined) {
          expect(definition["x-kind"]).toBe("url");
          expect(definition.type).toBe("string");
        }
      }
    });

    it("declares its children", () => {
      expect(schema["x-children"]).toBeDefined();
    });
  });

  const summary = (name: string) => {
    const schema = read(name);
    return {
      required: [...(schema.required ?? [])].sort(),
      props: Object.keys(schema.properties ?? {}).sort(),
      urls: Object.entries(schema.properties ?? {})
        .filter(([, definition]) => definition["x-kind"] === "url")
        .map(([prop]) => prop)
        .sort(),
    };
  };

  it("gives Video the props src, title, captions, and poster", () => {
    expect(summary("Video")).toEqual({ required: ["src", "title"], props: ["captions", "poster", "src", "title"], urls: ["captions", "poster", "src"] });
    expect(read("Video")["x-children"]).toBe("none");
  });

  it("gives Model3D the props src, alt, and poster, all required", () => {
    expect(summary("Model3D")).toEqual({ required: ["alt", "poster", "src"], props: ["alt", "poster", "src"], urls: ["poster", "src"] });
    expect(read("Model3D")["x-children"]).toBe("none");
  });

  it("gives Diagram a required alt and exactly one of src or source, as a oneOf over required", () => {
    expect(summary("Diagram")).toEqual({ required: ["alt"], props: ["alt", "source", "src"], urls: ["src"] });
    expect(read("Diagram").oneOf).toEqual([{ required: ["src"] }, { required: ["source"] }]);
    expect(read("Diagram")["x-children"]).toBe("none");
  });

  it("gives Image the required props src and alt", () => {
    expect(summary("Image")).toEqual({ required: ["alt", "src"], props: ["alt", "src"], urls: ["src"] });
    expect(read("Image")["x-children"]).toBe("none");
  });

  it("gives Callout a required type of tip, warning, or note and an optional title, and takes Markdown and components", () => {
    expect(summary("Callout")).toEqual({ required: ["type"], props: ["title", "type"], urls: [] });
    expect(read("Callout").properties?.type?.enum).toEqual(["tip", "warning", "note"]);
    expect(read("Callout")["x-children"]).toEqual({ markdown: true, components: "all" });
  });

  it("gives Tabs no props, and declares Tab inside it with a required label and Markdown and component children", () => {
    expect(summary("Tabs")).toEqual({ required: [], props: [], urls: [] });
    expect(read("Tabs")["x-children"]).toEqual({ markdown: false, components: ["Tab"], min: 2 });
    const tab = read("Tabs")["x-nested"]?.Tab;
    expect(Object.keys(read("Tabs")["x-nested"] ?? {})).toEqual(["Tab"]);
    expect(tab?.required).toEqual(["label"]);
    expect(tab?.properties?.label?.minLength).toBe(1);
    expect(tab?.additionalProperties).toBe(false);
    expect(tab?.["x-children"]).toEqual({ markdown: true, components: "all" });
  });

  it("gives CodeSteps a required step that matches a whole number of 1 or more, and an optional file", () => {
    expect(summary("CodeSteps")).toEqual({ required: ["step"], props: ["file", "step"], urls: [] });
    expect(read("CodeSteps").properties?.step?.pattern).toBe("^[1-9][0-9]*$");
    expect(read("CodeSteps")["x-children"]).toBe("none");
  });

  it("has no file for Tab", () => {
    expect(readdirSync(REAL_SCHEMAS)).not.toContain("Tab.schema.json");
  });

  it("is not imported by anything in content-build, and does not import from content-build", () => {
    const frontend = join(PART_DIR, "..", "frontend", "src");
    const files = (folder: string): string[] =>
      readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? files(join(folder, entry.name)) : [join(folder, entry.name)],
      );
    for (const file of files(frontend).filter((f) => /\.(ts|tsx)$/.test(f))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/from\s+["'][^"']*content-build/);
    }
    for (const file of files(join(PART_DIR, "src"))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/from\s+["'][^"']*frontend/);
    }
  });
});

describe("the real components in a lesson", () => {
  const compile = (body: string) => compileLesson(`---\ntitle: T\norder: 1\n---\n\n${body}\n`, { path: "l.mdx" });
  const messages = (body: string) => {
    const result = compile(body);
    return "problems" in result ? result.problems.map((p) => p.message) : [];
  };

  it.each([
    ['<Video src="https://example.com/a.mp4" title="" />', "the prop `title` of `<Video>` must not be empty"],
    ['<Video src="a.mp4" />', "`<Video>` is missing the required prop `title`"],
    ['<Model3D src="a.glb" alt="" poster="p.png" />', "the prop `alt` of `<Model3D>` must not be empty"],
    ['<Model3D src="a.glb" alt="A" />', "`<Model3D>` is missing the required prop `poster`"],
    ['<Diagram alt="" source="graph TD" />', "the prop `alt` of `<Diagram>` must not be empty"],
    ['<Diagram alt="A" />', "`<Diagram>` needs exactly one of `src` or `source`, but it has neither"],
    ['<Diagram alt="A" src="a.svg" source="graph TD" />', "`<Diagram>` needs exactly one of `src` or `source`, but it has both"],
    ['<Image src="a.png" alt="" />', "the prop `alt` of `<Image>` must not be empty"],
    ['<Callout type="danger" />', "the prop `type` of `<Callout>` must be one of `tip`, `warning`, `note`"],
    ["<Callout />", "`<Callout>` is missing the required prop `type`"],
    ['<Callout type="tip" title="" />', "the prop `title` of `<Callout>` must not be empty"],
    ['<CodeSteps step="0" />', "the prop `step` of `<CodeSteps>` must match the pattern `^[1-9][0-9]*$`"],
    ['<CodeSteps step="01" />', "the prop `step` of `<CodeSteps>` must match the pattern `^[1-9][0-9]*$`"],
    ['<CodeSteps step="1.5" />', "the prop `step` of `<CodeSteps>` must match the pattern `^[1-9][0-9]*$`"],
    ['<CodeSteps step="" />', "the prop `step` of `<CodeSteps>` must match the pattern `^[1-9][0-9]*$`"],
    ["<CodeSteps />", "`<CodeSteps>` is missing the required prop `step`"],
    ['<CodeSteps step="1" file="" />', "the prop `file` of `<CodeSteps>` must not be empty"],
    ["<Tabs foo=\"x\" />", "`<Tabs>` has an unknown prop `foo`; it takes no props"],
  ])("rejects %s", (body, message) => {
    expect(messages(body)).toContain(message);
  });

  it.each(['<CodeSteps step="1" />', '<CodeSteps step="12" file="a.py" />', '<Callout type="note" />'])("accepts %s", (body) => {
    expect(compile(body)).toHaveProperty("tree");
  });

  it("checks the scheme of the URL props of every real component", () => {
    const bad = (body: string) => messages(body).filter((m) => m.includes("URL"));

    expect(bad('<Video src="javascript:1" title="T" captions="data:x" poster="file:///x" />')).toHaveLength(3);
    expect(bad('<Model3D src="vbscript:1" alt="A" poster="//evil/x.png" />')).toHaveLength(2);
    expect(bad('<Diagram alt="A" src="data:image/svg+xml,x" />')).toHaveLength(1);
    expect(bad('<Image src="JAVASCRIPT:1" alt="A" />')).toHaveLength(1);
  });

  it("does not take Tab outside Tabs", () => {
    expect(messages('<Tab label="x" />')).toEqual([
      "unknown component `Tab`; the components are `Callout`, `CodeSteps`, `Diagram`, `Image`, `Model3D`, `Tabs`, `Video`",
    ]);
  });

  it("lets a Callout hold Markdown and components, and a Tabs hold two Tab elements", () => {
    expect(compile('<Callout type="tip">\n\nText\n\n<Image src="a.png" alt="A" />\n\n</Callout>')).toHaveProperty("tree");
    expect(compile('<Tabs>\n\n<Tab label="A">\n\na\n\n</Tab>\n\n<Tab label="B">\n\nb\n\n</Tab>\n\n</Tabs>')).toHaveProperty("tree");
  });
});

describe("the schema folder option", () => {
  it("is used instead of the real folder, so the rule tests do not depend on a real schema", () => {
    const body = "---\ntitle: T\norder: 1\n---\n\n<Flag />\n";

    expect(compileLesson(body, { path: "l.mdx", schemaDir: COMPONENT_FIXTURES })).toHaveProperty("tree");
    expect(compileLesson(body, { path: "l.mdx" })).toEqual({
      problems: [
        lessonProblem(
          "l.mdx",
          6,
          1,
          "unknown component `Flag`; the components are `Callout`, `CodeSteps`, `Diagram`, `Image`, `Model3D`, `Tabs`, `Video`",
        ),
      ],
    });
  });
});

describe("a schema that cannot be used is a build setup error", () => {
  const LESSON = "---\ntitle: T\norder: 1\n---\n\nText\n";

  function schemas(files: Record<string, string>): string {
    const dir = temporaryFolder();
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(dir, ...name.split("/").slice(0, -1)), { recursive: true });
      writeFileSync(join(dir, ...name.split("/")), content);
    }
    return dir;
  }
  const good = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "object", required: [], additionalProperties: false, properties: {}, "x-children": "none", ...extra });

  function failure(files: Record<string, string>): string {
    const dir = schemas(files);
    try {
      compileLesson(LESSON, { path: "l.mdx", schemaDir: dir });
    } catch (error) {
      expect(error).toBeInstanceOf(SetupError);
      return (error as Error).message.replaceAll("\\", "/").replace(dir.replaceAll("\\", "/"), "<dir>");
    }
    throw new Error("expected a SetupError");
  }

  it("stops the compile with a message that names the file, for text that is not JSON", () => {
    expect(failure({ "Broken.schema.json": "{ not json" })).toMatch(/^<dir>\/Broken\.schema\.json: not valid JSON \(/);
  });

  it("does not return a lesson problem for it, even for a lesson with no components", () => {
    const dir = schemas({ "Broken.schema.json": "[" });

    expect(() => compileLesson(LESSON, { path: "l.mdx", schemaDir: dir })).toThrow(SetupError);
  });

  it("names the file when the JSON is not a valid schema", () => {
    expect(failure({ "Bad.schema.json": good({ required: "src" }) })).toMatch(/^<dir>\/Bad\.schema\.json: not a valid component schema: /);
    expect(failure({ "Bad.schema.json": good({ properties: { a: { type: "string", minLength: "one" } } }) })).toMatch(
      /^<dir>\/Bad\.schema\.json: not a valid component schema: /,
    );
  });

  it("names the file when the schema is not an object of props", () => {
    expect(failure({ "A.schema.json": "[]" })).toBe("<dir>/A.schema.json: the schema must be a JSON object");
    expect(failure({ "A.schema.json": "null" })).toBe("<dir>/A.schema.json: the schema must be a JSON object");
    expect(failure({ "A.schema.json": good({ type: "string" }) })).toContain("<dir>/A.schema.json: `type` must be \"object\"");
    expect(failure({ "A.schema.json": good({ additionalProperties: true }) })).toContain("`additionalProperties` must be false");
    expect(failure({ "A.schema.json": JSON.stringify({ type: "object", additionalProperties: false, "x-children": "none" }) })).toContain(
      "`properties` must be an object",
    );
  });

  it("rejects a prop that is not a string or a boolean", () => {
    expect(failure({ "A.schema.json": good({ properties: { n: { type: "number" } } }) })).toContain("property `n` must have");
    expect(failure({ "A.schema.json": good({ properties: { n: {} } }) })).toContain("property `n` must have");
    expect(failure({ "A.schema.json": good({ properties: { n: { type: "object" } } }) })).toContain("property `n` must have");
  });

  it("rejects a required name that is not a property, in required and in a oneOf", () => {
    expect(failure({ "A.schema.json": good({ required: ["ghost"] }) })).toContain("`required` names `ghost`, which is not in `properties`");
    expect(failure({ "A.schema.json": good({ oneOf: [{ required: ["ghost"] }] }) })).toContain("`required` names `ghost`");
  });

  it("wants x-children, and checks its value", () => {
    expect(failure({ "A.schema.json": JSON.stringify({ type: "object", additionalProperties: false, properties: {} }) })).toContain(
      "`x-children` is missing",
    );
    expect(failure({ "A.schema.json": good({ "x-children": "some" }) })).toContain("not a valid component schema");
    expect(failure({ "A.schema.json": good({ "x-children": { markdown: true } }) })).toContain("not a valid component schema");
    expect(failure({ "A.schema.json": good({ "x-children": { markdown: true, components: "all", extra: 1 } }) })).toContain(
      "not a valid component schema",
    );
  });

  it("checks the value of x-kind and that it sits on a string", () => {
    expect(failure({ "A.schema.json": good({ properties: { u: { type: "string", "x-kind": "path" } } }) })).toContain("not a valid component schema");
    expect(failure({ "A.schema.json": good({ properties: { u: { type: "boolean", "x-kind": "url" } } }) })).toContain(
      "property `u` is a url, so its type must be \"string\"",
    );
  });

  it("rejects a keyword that ajv does not know, as strict mode does for every other schema", () => {
    expect(failure({ "A.schema.json": good({ "x-unknown": true }) })).toContain("not a valid component schema");
  });

  it("rejects a file name that is not <Name>.schema.json with a capital letter", () => {
    expect(failure({ "callout.schema.json": good() })).toContain("the file name must be <Name>.schema.json");
    expect(failure({ "Call-out.schema.json": good() })).toContain("the file name must be <Name>.schema.json");
  });

  it("rejects a nested component with the name of a file, or one with nested components of its own", () => {
    const nested = (name: string) => good({ "x-nested": { [name]: JSON.parse(good()) } });

    expect(failure({ "A.schema.json": nested("B"), "B.schema.json": good() })).toContain("the nested component `B` has the same name as B.schema.json");
    expect(failure({ "A.schema.json": nested("b") })).toContain("the nested component name `b` must start with a capital letter");
    expect(failure({ "A.schema.json": good({ "x-nested": { B: JSON.parse(good({ "x-nested": { C: JSON.parse(good()) } })) } }) })).toContain(
      "`B` cannot have nested components of its own",
    );
    expect(failure({ "A.schema.json": good({ "x-nested": [] }) })).toContain("`x-nested` must be an object of schemas");
  });

  it("names the folder when it cannot be read", () => {
    expect(() => loadComponentSchemas(join(temporaryFolder(), "nowhere"))).toThrow(/^the component schema folder cannot be read: /);
  });

  it("ignores a file or folder that is not a schema", () => {
    const dir = schemas({ "README.md": "x", "A.schema.json": good(), "sub/B.schema.json": "not json", "C.json": "x" });

    expect([...loadComponentSchemas(dir).keys()]).toEqual(["A"]);
  });

  it("loads nothing from a folder with no schemas, so every component is unknown", () => {
    const dir = schemas({ "README.md": "x" });

    expect(compileLesson("---\ntitle: T\norder: 1\n---\n\n<Callout />\n", { path: "l.mdx", schemaDir: dir })).toEqual({
      problems: [lessonProblem("l.mdx", 6, 1, "unknown component `Callout`; the components are ")],
    });
  });

  it("compares names exactly, as listed in the folder", () => {
    const dir = schemas({ "Callout.schema.json": good() });
    const text = (name: string) => `---\ntitle: T\norder: 1\n---\n\n<${name} />\n`;

    expect(compileLesson(text("Callout"), { path: "l.mdx", schemaDir: dir })).toHaveProperty("tree");
    expect(compileLesson(text("CALLOUT"), { path: "l.mdx", schemaDir: dir })).toHaveProperty("problems");
  });
});
