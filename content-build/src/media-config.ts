// media-config.json: the only list of media origins and asset size limits.

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SetupError } from "./component-schemas.ts";
import mediaConfigSchema from "../schemas/media-config.schema.json" with { type: "json" };
import { newAjv } from "./schema.ts";

export type EmbedRule = {
  /** The https origin of the embed player. */
  origin: string;
  /** The path before the video ID, with a slash at both ends. */
  pathPrefix: string;
  /** A regular expression, from ^ to $, that the video ID must match. */
  idPattern: string;
  /** Hosts of the site's watch pages. */
  watchHosts: string[];
};

export type AssetLimits = { imageBytes: number; modelBytes: number; captionBytes: number };

export type MediaConfig = {
  mediaOrigins: string[];
  embeds: EmbedRule[];
  assetLimits: AssetLimits;
};

/** The committed config, found from this file's location, never from the working folder. */
export const DEFAULT_MEDIA_CONFIG = join(dirname(fileURLToPath(import.meta.url)), "..", "media-config.json");

const validateConfig = newAjv().compile(mediaConfigSchema);

/**
 * Reads and checks the media config. A file that cannot be read, is not JSON, does not match
 * `schemas/media-config.schema.json`, or has an origin that is not exactly what `new URL(origin).origin`
 * returns (https only, lowercase host, no path, no credentials), or a repeat, throws a `SetupError` that
 * names the file and the key.
 */
export function loadMediaConfig(path: string = DEFAULT_MEDIA_CONFIG): MediaConfig {
  const name = basename(path);
  const fail = (key: string, problem: string): never => {
    throw new SetupError(`${name}: ${key} ${problem}`);
  };

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    const reason = error instanceof SyntaxError ? `is not valid JSON (${error.message})` : "cannot be read";
    throw new SetupError(`${name}: the file ${reason}`);
  }
  if (!validateConfig(data)) {
    const first = validateConfig.errors?.[0];
    const where = first === undefined || first.instancePath === "" ? "the file" : `\`${keyPath(first.instancePath)}\``;
    const extra = first?.keyword === "additionalProperties" ? ` (unknown key \`${String(first.params.additionalProperty)}\`)` : "";
    return fail(where, `${first?.message ?? "does not match media-config.schema.json"}${extra}`);
  }
  const config = data as MediaConfig;

  const seen = new Set<string>();
  const checkOrigin = (key: string, origin: string) => {
    const problem = originProblem(origin);
    if (problem !== undefined) fail(`\`${key}\``, `${problem} (got "${origin}")`);
    if (seen.has(origin)) fail(`\`${key}\``, `repeats the origin "${origin}", which is already listed`);
    seen.add(origin);
  };
  config.mediaOrigins.forEach((origin, i) => checkOrigin(`mediaOrigins[${i}]`, origin));
  config.embeds.forEach((embed, i) => {
    const key = `embeds[${i}]`;
    checkOrigin(`${key}.origin`, embed.origin);
    if (!embed.idPattern.startsWith("^") || !embed.idPattern.endsWith("$")) {
      fail(`\`${key}.idPattern\``, `must start with ^ and end with $ (got "${embed.idPattern}")`);
    }
    try {
      new RegExp(embed.idPattern);
    } catch {
      fail(`\`${key}.idPattern\``, `is not a valid regular expression (got "${embed.idPattern}")`);
    }
    const hosts = new Set<string>();
    embed.watchHosts.forEach((host, j) => {
      if (!isHost(host)) fail(`\`${key}.watchHosts[${j}]\``, `must be a lowercase host name with no scheme, port, or path (got "${host}")`);
      if (hosts.has(host)) fail(`\`${key}.watchHosts[${j}]\``, `repeats the host "${host}"`);
      hosts.add(host);
    });
  });
  return config;
}

/** `/embeds/0/origin` as `embeds[0].origin`. */
function keyPath(pointer: string): string {
  return pointer
    .split("/")
    .slice(1)
    .reduce((path, part) => (/^\d+$/.test(part) ? `${path}[${part}]` : path === "" ? part : `${path}.${part}`), "");
}

/** Why `origin` is not an allowed origin, or undefined when it is exactly what `new URL(origin).origin` returns for an https URL. */
function originProblem(origin: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return "is not a URL";
  }
  if (parsed.protocol !== "https:") return "must start with https://";
  if (parsed.origin !== origin) {
    return `must be written exactly as ${parsed.origin}: a lowercase host, no path or trailing slash, no credentials, no default port`;
  }
  if (!/^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(origin)) {
    return "must have a host of lowercase letters, digits, dots, and hyphens, so no wildcard";
  }
  return undefined;
}

function isHost(host: string): boolean {
  try {
    return /^[a-z0-9.-]+$/.test(host) && new URL(`https://${host}`).host === host;
  } catch {
    return false;
  }
}
