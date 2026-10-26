// mermaid-config.json: the only place the Mermaid render settings live.

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SetupError } from "./component-schemas.ts";
import mermaidConfigSchema from "../schemas/mermaid-config.schema.json" with { type: "json" };
import { newAjv } from "./schema.ts";

/** The committed config, found from this file's location, never from the working folder. */
export const DEFAULT_MERMAID_CONFIG = join(dirname(fileURLToPath(import.meta.url)), "..", "mermaid-config.json");

const validateConfig = newAjv().compile(mermaidConfigSchema);

/** The config as parsed, and its bytes (the cache key hashes them): the file's text as UTF-8 with LF line endings, so a checkout with CRLF gives the same key. */
export type MermaidConfig = { bytes: Uint8Array; settings: Record<string, unknown> };

/** Reads and checks the config. A file that cannot be read, is not JSON, or does not match `schemas/mermaid-config.schema.json` throws a `SetupError` that names the file and the key. */
export function loadMermaidConfig(path: string = DEFAULT_MERMAID_CONFIG): MermaidConfig {
  const name = basename(path);
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new SetupError(`${name}: the file cannot be read`);
  }
  let data: unknown;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    data = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof SyntaxError ? `is not valid JSON (${error.message})` : "is not valid UTF-8 text";
    throw new SetupError(`${name}: the file ${reason}`);
  }
  if (!validateConfig(data)) {
    const first = validateConfig.errors?.[0];
    const key = (first?.instancePath ?? "").split("/").filter((part) => part !== "").join(".");
    const extra = first?.keyword === "additionalProperties" ? ` (unknown key \`${String(first.params.additionalProperty)}\`)` : "";
    throw new SetupError(`${name}: ${key === "" ? "the file" : `\`${key}\``} ${first?.message ?? "does not match mermaid-config.schema.json"}${extra}`);
  }
  return { bytes: new TextEncoder().encode(text.replace(/\r\n?/g, "\n")), settings: data as Record<string, unknown> };
}
