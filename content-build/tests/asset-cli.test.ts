// The `validate` command prints the asset problems in the same format as the others.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { PART_DIR } from "./helpers.ts";

function run(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = main(args, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) });
  return { code, stdout, stderr };
}

describe("validate with assets", () => {
  it("prints a file problem on assets/<path>, with a line for an SVG rule", () => {
    const result = run("fixtures/invalid/asset-svg-rejected");

    expect(result).toEqual({
      code: 1,
      stderr: "",
      stdout:
        "fixtures/invalid/asset-svg-rejected/assets/images/bad.svg:2: error: the SVG has a `<script>` element, which can run code, load a page, or animate; remove it\n" +
        "1 error(s), 0 warning(s)\n",
    });
  });

  it("prints a lesson problem with its line and column", () => {
    const result = run("fixtures/invalid/ref-missing-file");

    expect(result.code).toBe(1);
    expect(result.stdout).toBe(
      "fixtures/invalid/ref-missing-file/chapters/01-intro/lessons/01-hello.mdx:8:8: error: the prop `src` of `<Image>`: there is no file `images/pic.png` in assets/\n" +
        "1 error(s), 0 warning(s)\n",
    );
  });

  it("prints the warning for an unused file, and exits 0", () => {
    const result = run("fixtures/warnings/asset-unused");

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      "fixtures/warnings/asset-unused/assets/diagrams/unused.svg: warning: no lesson uses this file; use it in a lesson or remove it\n" +
        "fixtures/warnings/asset-unused/assets/images/unused.png: warning: no lesson uses this file; use it in a lesson or remove it\n" +
        "0 error(s), 2 warning(s)\n",
    );
  });

  it("accepts the valid course with 0 errors and 0 warnings, through the real command", () => {
    const result = spawnSync(process.execPath, [join(PART_DIR, "src", "validate.ts"), "fixtures/valid/sample-course"], { cwd: PART_DIR, encoding: "utf8" });

    expect(result.stdout).toBe("0 error(s), 0 warning(s)\n");
    expect(result.status).toBe(0);
  });
});
