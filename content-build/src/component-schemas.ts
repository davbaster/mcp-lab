// Loads the props schemas of the lesson components (frontend/src/content-components/schemas/).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ValidateFunction } from "ajv";
import { listFolder, readText } from "./folder.ts";
import { toPosix } from "./problem.ts";
import { newAjv } from "./schema.ts";

/**
 * The build cannot run because of a problem in its own setup (a component schema that is not valid),
 * not because of a lesson. It is thrown, never reported as a lesson problem.
 */
export class SetupError extends Error {
  override name = "SetupError";
}

/** The folder of the component schemas, found from this file's location, never from the working folder. */
export const DEFAULT_SCHEMA_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "frontend",
  "src",
  "content-components",
  "schemas",
);

/** What a component may hold between its tags. */
export type ChildrenRule = {
  /** Markdown (paragraphs, lists, code, ...) is allowed. */
  markdown: boolean;
  /** "all" is every component that has a schema file; a list names the allowed ones, and [] allows none. */
  components: "all" | string[];
  /** At least this many component children. */
  min?: number;
};

export type PropSchema = {
  type: "string" | "boolean";
  /** The prop is a URL (`"x-kind": "url"`): its scheme is checked. */
  url: boolean;
};

export type ComponentSchema = {
  name: string;
  props: Map<string, PropSchema>;
  /** Checks an object of the props that the author wrote. */
  validate: ValidateFunction;
  /** For a schema with a `oneOf` over `required`: the prop names of each branch. */
  oneOf: string[][];
  children: ChildrenRule;
  /** Components that exist only inside this one (`x-nested`), such as `Tab` in `Tabs`. */
  nested: Map<string, ComponentSchema>;
};

/** The components by name, in the order of the folder listing. */
export type ComponentSchemas = Map<string, ComponentSchema>;

const NAME = /^[A-Z][A-Za-z0-9]*$/;
const SUFFIX = ".schema.json";

const CHILDREN_KEYWORD = {
  oneOf: [
    { const: "none" },
    {
      type: "object",
      required: ["markdown", "components"],
      additionalProperties: false,
      properties: {
        markdown: { type: "boolean" },
        components: {
          oneOf: [{ const: "all" }, { type: "array", items: { type: "string", pattern: "^[A-Z][A-Za-z0-9]*$" }, uniqueItems: true }],
        },
        min: { type: "integer", minimum: 1 },
      },
    },
  ],
};

/**
 * Reads every `<Name>.schema.json` of the folder, by the names the folder listing gives (so `<CALLOUT>`
 * never finds `Callout.schema.json`, even where the file system ignores case), and compiles it in
 * ajv's strict mode. Throws a `SetupError` that names the file when one is not valid JSON or not a
 * valid component schema.
 */
export function loadComponentSchemas(dir: string): ComponentSchemas {
  const found = listFolder(dir);
  if (found === undefined) throw new SetupError(`the component schema folder cannot be read: ${toPosix(dir)}`);

  // strictRequired is off so that a `oneOf` over `required` needs no copy of the properties; compileComponent checks the names itself.
  const ajv = newAjv({ strictRequired: false });
  // Annotations: ajv in strict mode rejects a keyword it does not know. Their values are checked as the schema compiles.
  ajv.addKeyword({ keyword: "x-kind", schemaType: "string", metaSchema: { const: "url" } });
  ajv.addKeyword({ keyword: "x-children", schemaType: ["string", "object"], metaSchema: CHILDREN_KEYWORD });
  ajv.addKeyword({ keyword: "x-nested", schemaType: "object", metaSchema: { type: "object" } });

  const components: ComponentSchemas = new Map();
  for (const [file, kind] of found) {
    if (kind !== "file" || !file.endsWith(SUFFIX)) continue;
    const where = toPosix(join(dir, file));
    const name = file.slice(0, -SUFFIX.length);
    if (!NAME.test(name)) {
      throw new SetupError(`${where}: the file name must be <Name>.schema.json, where Name starts with a capital letter and uses only letters and digits`);
    }
    const read = readText(join(dir, file));
    if ("error" in read) throw new SetupError(`${where}: ${read.error}`);
    let json: unknown;
    try {
      json = JSON.parse(read.text);
    } catch (error) {
      throw new SetupError(`${where}: not valid JSON (${error instanceof Error ? error.message : "unreadable"})`);
    }
    components.set(name, compileComponent(ajv, name, json, where));
  }
  // A nested component is found only inside its parent, so a file of the same name would be ambiguous.
  for (const component of components.values()) {
    for (const nestedName of component.nested.keys()) {
      if (components.has(nestedName)) {
        throw new SetupError(`${toPosix(join(dir, `${component.name}${SUFFIX}`))}: the nested component \`${nestedName}\` has the same name as ${nestedName}${SUFFIX}`);
      }
    }
  }
  return components;
}

type Ajv = ReturnType<typeof newAjv>;

function compileComponent(ajv: Ajv, name: string, json: unknown, where: string): ComponentSchema {
  const fail = (what: string): never => {
    throw new SetupError(`${where}: ${what}`);
  };
  const schema = asObject(json);
  if (schema === undefined) return fail("the schema must be a JSON object");
  if (schema.type !== "object") fail('`type` must be "object": the schema describes the object of props');
  if (schema.additionalProperties !== false) fail("`additionalProperties` must be false, so an unknown prop is rejected");
  const properties = asObject(schema.properties);
  if (properties === undefined) return fail("`properties` must be an object (use {} for a component with no props)");
  if (!("x-children" in schema)) fail('`x-children` is missing; write "none" or say what the component may hold');

  const props = new Map<string, PropSchema>();
  for (const [prop, value] of Object.entries(properties)) {
    const propSchema = asObject(value);
    const type = propSchema?.type;
    if (type !== "string" && type !== "boolean") {
      fail(`property \`${prop}\` must have "type": "string" or "type": "boolean", because authors can only write text or a bare attribute`);
    }
    const url = propSchema?.["x-kind"] === "url";
    if (url && type !== "string") fail(`property \`${prop}\` is a url, so its type must be "string"`);
    props.set(prop, { type: type as PropSchema["type"], url });
  }

  const nested = new Map<string, ComponentSchema>();
  const { "x-nested": nestedSchemas, ...own } = schema;
  if (nestedSchemas !== undefined) {
    const map = asObject(nestedSchemas);
    if (map === undefined) return fail("`x-nested` must be an object of schemas");
    for (const [nestedName, nestedJson] of Object.entries(map)) {
      if (!NAME.test(nestedName)) fail(`the nested component name \`${nestedName}\` must start with a capital letter and use only letters and digits`);
      if (nestedName === name || nested.has(nestedName)) fail(`the nested component \`${nestedName}\` has the same name as another component`);
      if (asObject(nestedJson)?.["x-nested"] !== undefined) fail(`\`${nestedName}\` cannot have nested components of its own`);
      nested.set(nestedName, compileComponent(ajv, nestedName, nestedJson, where));
    }
  }

  const oneOf = oneOfNames(own.oneOf);
  const required = Array.isArray(own.required) ? own.required : [];
  for (const prop of [...required, ...oneOf.flat()]) {
    if (typeof prop !== "string" || !props.has(prop)) fail(`\`required\` names \`${String(prop)}\`, which is not in \`properties\``);
  }

  let validate: ValidateFunction;
  try {
    validate = ajv.compile(own);
  } catch (error) {
    return fail(`not a valid component schema: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  return { name, props, validate, oneOf, children: childrenRule(own["x-children"]), nested };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** The `x-children` value, already checked by ajv as the schema compiled. */
function childrenRule(value: unknown): ChildrenRule {
  if (value === "none") return { markdown: false, components: [] };
  const rule = value as { markdown: boolean; components: "all" | string[]; min?: number };
  return rule.min === undefined
    ? { markdown: rule.markdown, components: rule.components }
    : { markdown: rule.markdown, components: rule.components, min: rule.min };
}

function oneOfNames(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value.map((branch) => {
    const required = asObject(branch)?.required;
    return Array.isArray(required) ? required.filter((item): item is string => typeof item === "string") : [];
  });
}
