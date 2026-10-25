// The cache of rendered diagrams: one `<key>.svg` file per source, outside the build folder, never deleted by `build`.
//
// The key is the SHA-256 of everything that changes the bytes of a rendering, so an entry can only be used for the same input.
// A cache file is read with the same rules as a rendering: an entry that is empty, is not UTF-8, or fails the SVG rules is ignored.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSource } from "./diagram-source.ts";
import { POSTPROCESS_VERSION } from "./diagram-svg.ts";
import { svgProblems } from "./svg.ts";

/** The default cache folder: `content-build/.cache/mermaid/`, found from this file's location, never from the working folder. */
export const DEFAULT_CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".cache", "mermaid");

/** Everything that decides the bytes of a rendering. */
export type CacheKeyParts = {
  /** The Mermaid text. CRLF counts as LF. */
  source: string;
  /** The bytes of `mermaid-config.json`. */
  config: Uint8Array;
  /** The installed versions of `mermaid` and `@mermaid-js/mermaid-cli`, and the build of Chromium. */
  mermaid: string;
  mermaidCli: string;
  chromium: string;
  /** Defaults to the version of the post-processing in code. */
  postprocess?: number;
};

/** The 64 hex digits of the key. Each part is hashed with its name and length, so no two inputs give the same bytes to hash. */
export function cacheKey(parts: CacheKeyParts): string {
  const hash = createHash("sha256");
  const add = (name: string, value: Uint8Array | string) => {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    hash.update(`${name}:${bytes.length}:`);
    hash.update(bytes);
    hash.update("\n");
  };
  add("source", normalizeSource(parts.source));
  add("config", parts.config);
  add("mermaid", parts.mermaid);
  add("mermaid-cli", parts.mermaidCli);
  add("chromium", parts.chromium);
  add("postprocess", String(parts.postprocess ?? POSTPROCESS_VERSION));
  return hash.digest("hex");
}

/** The cache folder: `MERMAID_CACHE_DIR` when set (relative to the working folder), else the default. */
export function cacheDirectory(env: Record<string, string | undefined>, override?: string): string {
  if (override !== undefined) return resolve(override);
  const fromEnv = env.MERMAID_CACHE_DIR;
  return fromEnv !== undefined && fromEnv.trim() !== "" ? resolve(fromEnv) : DEFAULT_CACHE_DIR;
}

const KEY = /^[0-9a-f]{64}$/;

export class SvgCache {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }

  /** The file for a key. A name is only ever built from 64 hex digits. */
  fileFor(key: string): string {
    if (!KEY.test(key)) throw new Error("internal error: a cache key is 64 hex digits");
    return join(this.directory, `${key}.svg`);
  }

  /** The cached SVG, or undefined when there is none or the entry is not good (empty, not UTF-8, or rejected by the SVG rules). */
  read(key: string): string | undefined {
    const file = this.fileFor(key);
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(file);
    } catch {
      return undefined;
    }
    if (bytes.length === 0) return undefined;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return undefined;
    }
    if (text.startsWith("﻿") || svgProblems(text).length > 0) return undefined;
    return text;
  }

  /** Keeps an SVG for a key. A cache that cannot be written (read-only folder) is not an error of the build. */
  write(key: string, svg: string): void {
    const file = this.fileFor(key);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      mkdirSync(this.directory, { recursive: true });
      writeFileSync(temporary, svg, "utf8");
      renameSync(temporary, file);
    } catch {
      try {
        rmSync(temporary, { force: true });
      } catch {
        // nothing more to do
      }
    }
  }
}
