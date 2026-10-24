// JSON Schema checks (ajv) with error messages that name the field instead of the schema keyword.

import { Ajv } from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";
import courseSchema from "../schemas/course.schema.json" with { type: "json" };
import lessonFrontMatterSchema from "../schemas/lesson-front-matter.schema.json" with { type: "json" };
import type { ParsedYaml, PathSegment } from "./yaml-file.ts";

export type ShapeProblem = { line?: number; message: string };

const ajv = new Ajv({ allErrors: true, strict: true });

export const courseShape: Shape = { validate: ajv.compile(courseSchema), root: "course.yaml" };
export const lessonFrontMatterShape: Shape = {
  validate: ajv.compile(lessonFrontMatterSchema),
  root: "the front matter",
};

/** Compiles another schema with the same ajv setup (strict mode). */
export function compileShape(schema: object, options: Omit<Shape, "validate">): Shape {
  return { validate: ajv.compile(schema), ...options };
}

export type Shape = {
  validate: ValidateFunction;
  /** How the top level is called in a message, such as "course.yaml". */
  root: string;
  /**
   * Names the part of the file that a field belongs to, so that a message can say "question `tools-2`"
   * instead of `questions[2]`. Gets the path of the field and the whole value; `rest` is the part of
   * the path inside `scope`. Without it, a message names the field by its whole path.
   */
  locate?: (path: readonly PathSegment[], value: unknown) => { scope: string; rest: PathSegment[] };
  /** Never quote the checked value in a message. */
  quiet?: boolean;
  /** A missing field is reported at the line of the mapping that lacks it, when that has a line. */
  lineForMissing?: boolean;
};

const NAME_RULE = "use only lowercase letters, digits, and hyphens";
const NO_WHITESPACE = "^\\S+$";

/** Checks `value` (parsed from `source`) against the shape. Returns no problems when it conforms. */
export function checkShape(shape: Shape, value: unknown, source: ParsedYaml): ShapeProblem[] {
  if (shape.validate(value)) return [];
  const problems: ShapeProblem[] = [];
  const add = (message: string, line: number | undefined) => {
    if (!problems.some((p) => p.message === message && p.line === line)) {
      problems.push(line === undefined ? { message } : { line, message });
    }
  };
  // `build` gets the field as the message names it: the whole path, or the path inside its scope.
  const say = (fieldPath: PathSegment[], build: (field: string) => string): string => {
    const { scope, rest } = shape.locate?.(fieldPath, value) ?? { scope: "", rest: fieldPath };
    if (rest.length === 0) return build(scope === "" ? shape.root : scope);
    return scope === "" ? build(`\`${label(rest)}\``) : `${scope}: ${build(`\`${label(rest)}\``)}`;
  };
  for (const error of shape.validate.errors ?? []) {
    const path = pointerToPath(error.instancePath);
    const instance = valueAt(value, path);
    if (error.keyword === "uniqueItems") {
      for (const { name, index } of repeatedNames(instance)) {
        add(say(path, (field) => `${field} lists \`${name}\` more than once`), source.lineOf([...path, index]));
      }
    } else if (error.keyword === "additionalProperties") {
      const key = String(error.params.additionalProperty);
      add(say([...path, key], (field) => `unknown key ${field}`), source.lineOfKey(path, key));
    } else if (error.keyword === "required") {
      const missing = String(error.params.missingProperty);
      add(
        say([...path, missing], (field) => `missing required field ${field}`),
        shape.lineForMissing ? source.lineOf(path) : undefined,
      );
    } else {
      add(say(path, (field) => describe(error, path, field, instance, shape.quiet === true)), source.lineOf(path));
    }
  }
  return problems;
}

function describe(
  error: ErrorObject,
  path: PathSegment[],
  field: string,
  instance: unknown,
  quiet: boolean,
): string {
  switch (error.keyword) {
    case "type":
      return `${field} must be ${TYPE_NAMES[String(error.params.type)] ?? String(error.params.type)}`;
    case "minItems":
      return path.length === 1 && path[0] === "chapters"
        ? "`chapters` must list at least one chapter"
        : `${field} must have at least ${String(error.params.limit)} item(s)`;
    case "minimum":
      return `${field} must be ${String(error.params.limit)} or more`;
    case "pattern":
      // The text rule (`\S`) and the name rule both reject an empty string; say so plainly.
      if (typeof instance === "string" && instance.trim() === "") return `${field} must not be empty`;
      if (error.params.pattern === NO_WHITESPACE) return `${field} must not contain white space`;
      return quiet ? `${field} must ${NAME_RULE}` : `${field} must ${NAME_RULE} (got ${JSON.stringify(instance)})`;
    default:
      return `${field} ${error.message ?? "is not valid"}`;
  }
}

const TYPE_NAMES: Record<string, string> = {
  string: "a string",
  integer: "an integer",
  array: "a list",
  object: "a mapping of keys to values",
};

/** `chapters[1]` for the path ["chapters", 1]. */
function label(path: readonly PathSegment[]): string {
  return path.reduce<string>(
    (text, part) => (typeof part === "number" ? `${text}[${part}]` : text === "" ? part : `${text}.${part}`),
    "",
  );
}

/** The items that repeat an earlier item of the list, with the index of the repeat. */
function repeatedNames(list: unknown): { name: string; index: number }[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<unknown>();
  const repeats: { name: string; index: number }[] = [];
  list.forEach((item, index) => {
    if (typeof item === "string" && seen.has(item)) repeats.push({ name: item, index });
    seen.add(item);
  });
  return repeats;
}

/** Turns an ajv JSON pointer such as "/chapters/1" into ["chapters", 1]. */
function pointerToPath(pointer: string): PathSegment[] {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

function valueAt(root: unknown, path: readonly PathSegment[]): unknown {
  let current = root;
  for (const part of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<PathSegment, unknown>)[part];
  }
  return current;
}
