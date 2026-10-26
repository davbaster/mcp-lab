// The versions that decide the bytes of a rendering, read from the installed packages (never from package.json, which may say a range).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { SetupError } from "./component-schemas.ts";
import { chromiumBuild } from "./mermaid-render.ts";

export type RenderVersions = { mermaid: string; mermaidCli: string; chromium: string };

/** The version of the package `name` that `node` would load from `fromDir`: the nearest `node_modules/<name>/package.json` up the tree. */
function installedVersion(name: string, fromDir: string): string {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const file = join(dir, "node_modules", ...name.split("/"), "package.json");
    if (existsSync(file)) {
      const version = (JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version;
      if (typeof version === "string") return version;
    }
    if (dir === parse(dir).root) throw new SetupError(`the package ${name} is not installed (looked for it from ${fromDir}); run \`make install-content-build\``);
  }
}

/** The folder of the package `name`, found from this file. */
function packageFolder(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.resolve(name)));
  while (!existsSync(join(dir, "package.json")) || (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown }).name !== name) {
    const parent = dirname(dir);
    if (parent === dir) throw new SetupError(`the package ${name} is not installed; run \`make install-content-build\``);
    dir = parent;
  }
  return dir;
}

/** The installed `mermaid` (the one that `@mermaid-js/mermaid-cli` loads), `@mermaid-js/mermaid-cli`, and the pinned build of Chromium. */
export async function installedVersions(): Promise<RenderVersions> {
  const cli = packageFolder("@mermaid-js/mermaid-cli");
  return { mermaid: installedVersion("mermaid", cli), mermaidCli: String((JSON.parse(readFileSync(join(cli, "package.json"), "utf8")) as { version?: unknown }).version), chromium: await chromiumBuild() };
}
