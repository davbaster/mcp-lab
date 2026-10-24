// The `compile` command: output, exit codes, paths typed either way, and the real process.

import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/compile-cli.ts";
import { COMPONENT_FIXTURES, LESSON_FIXTURES, PART_DIR, SLOW_PROCESS_TIMEOUT_MS, temporaryFolder, toLf } from "./helpers.ts";

const VALID = join(LESSON_FIXTURES, "valid");
const INVALID = join(LESSON_FIXTURES, "invalid");

function run(args: string[], options: { schemaDir?: string } = {}) {
  let stdout = "";
  let stderr = "";
  const code = main(args, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) }, options);
  return { code, stdout, stderr };
}

describe("a lesson that compiles", () => {
  it("prints the tree on stdout, nothing on stderr, and exits 0", () => {
    const result = run([join(VALID, "markdown.mdx")]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(readFileSync(join(VALID, "markdown.json"), "utf8"));
  });

  it("prints the tree as 2-space indented JSON with LF line endings and a final newline", () => {
    const { stdout } = run([join(VALID, "components.mdx")]);

    expect(stdout.startsWith('{\n  "type": "root",\n  "children": [\n    {\n')).toBe(true);
    expect(stdout.endsWith("}\n")).toBe(true);
    expect(stdout.endsWith("\n\n")).toBe(false);
    expect(stdout).not.toContain("\r");
    expect(JSON.parse(stdout)).toHaveProperty("type", "root");
  });

  it("prints the empty root for a lesson with front matter and no body", () => {
    expect(run([join(VALID, "empty-body.mdx")]).stdout).toBe('{\n  "type": "root",\n  "children": []\n}\n');
  });

  it("takes the path with / or with \\", () => {
    const slashes = run(["fixtures/lessons/valid/markdown.mdx"]);
    const backslashes = run(["fixtures\\lessons\\valid\\markdown.mdx"]);

    expect(slashes.code).toBe(0);
    expect(backslashes).toEqual(slashes);
  });

  it("uses the schema folder it is given", () => {
    expect(run([join(VALID, "bare-attribute.mdx")], { schemaDir: COMPONENT_FIXTURES }).code).toBe(0);
    expect(run([join(VALID, "bare-attribute.mdx")]).code).toBe(1);
  });
});

describe("a lesson that is rejected", () => {
  it("writes nothing to stdout, the problems and the summary to stderr, and exits 1", () => {
    const result = run(["fixtures/lessons/invalid/several-problems.mdx"], { schemaDir: COMPONENT_FIXTURES });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      [
        "fixtures/lessons/invalid/several-problems.mdx:6:11: error: JavaScript expressions in curly braces are not allowed; to show a brace as text, write `\\{` or put it in a code span",
        "fixtures/lessons/invalid/several-problems.mdx:8:1: error: `import` and `export` statements are not allowed in a lesson",
        "fixtures/lessons/invalid/several-problems.mdx:10:1: error: `<script>` is not allowed in a lesson",
        "fixtures/lessons/invalid/several-problems.mdx:12:1: error: unknown component `Iframe`; the components are `Callout`, `Diagram`, `Flag`, `Image`, `Step`, `Tabs`, `Video`",
        "fixtures/lessons/invalid/several-problems.mdx:14:1: error: link: the URL scheme `javascript:` is not allowed; use http, https, mailto, or a relative URL",
        "5 error(s), 0 warning(s)",
        "",
      ].join("\n"),
    );
  });

  it("prints the path with / even when it was typed with \\", () => {
    const result = run(["fixtures\\lessons\\invalid\\expression-flow.mdx"]);

    expect(result.code).toBe(1);
    expect(result.stderr.split("\n")[0]).toMatch(/^fixtures\/lessons\/invalid\/expression-flow\.mdx:6:1: error: /);
    expect(result.stderr).not.toContain("\\\\");
  });

  it("rejects a lesson without front matter at 1:1 with the course check's message", () => {
    const result = run([join(INVALID, "front-matter-missing.mdx")]);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      `${join(INVALID, "front-matter-missing.mdx").replaceAll("\\", "/")}:1:1: error: the lesson must start with a front-matter block: a \`---\` line, the settings, and a closing \`---\` line\n1 error(s), 0 warning(s)\n`,
    );
  });

  it("rejects a file that does not exist", () => {
    const result = run(["fixtures/lessons/valid/no-such-lesson.mdx"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("fixtures/lessons/valid/no-such-lesson.mdx: error: the file cannot be read (ENOENT)\n1 error(s), 0 warning(s)\n");
  });

  it("rejects a path that is a folder", () => {
    const result = run([VALID]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: the file cannot be read (EISDIR)");
  });

  it("rejects a file that is not UTF-8 text", () => {
    const file = join(temporaryFolder(), "01-bytes.mdx");
    writeFileSync(file, Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x00]));
    const result = run([file]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: the file is not valid UTF-8");
  });

  it("rejects a file saved as UTF-16, as Windows PowerShell 5.1 writes a redirect", () => {
    const file = join(temporaryFolder(), "01-utf16.mdx");
    writeFileSync(file, Buffer.from(`\uFEFF---\ntitle: T\norder: 1\n---\n\nText\n`, "utf16le"));
    const result = run([file]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
  });
});

describe("a bad command line", () => {
  it.each([[[]], [["  "]], [[""]], [["a.mdx", "b.mdx"]]])("prints the usage on stderr and exits 2 for %j", (args) => {
    const result = run(args);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("give one lesson file to compile");
    expect(result.stderr).toContain("usage: npm run compile -- <lesson.mdx>");
  });
});

describe("a component schema that is not valid", () => {
  it("writes a build setup error to stderr and exits 3, not 1", () => {
    const dir = temporaryFolder();
    writeFileSync(join(dir, "Broken.schema.json"), "{");
    const result = run([join(VALID, "markdown.mdx")], { schemaDir: dir });

    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^build setup error: .*Broken\.schema\.json: not valid JSON \(/);
  });
});

describe("the real command", () => {
  // Runs the same thing as `npm run compile -- <path>` (node src/compile.ts), in a separate process.
  function node(cwd: string, ...args: string[]) {
    const result = spawnSync(process.execPath, [join(PART_DIR, "src", "compile.ts"), ...args], { cwd, encoding: "buffer" });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr.toString("utf8") };
  }

  it("exits 0 and writes the golden bytes to stdout, with nothing on stderr", () => {
    const result = node(PART_DIR, "fixtures/lessons/valid/components.mdx");

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.equals(readFileSync(join(VALID, "components.json")))).toBe(true);
  });

  it("writes the same bytes from two different working folders", () => {
    const here = node(PART_DIR, "fixtures/lessons/valid/components.mdx");
    const elsewhere = node(temporaryFolder(), join(VALID, "components.mdx"));

    expect(elsewhere.code).toBe(0);
    expect(elsewhere.stdout.equals(here.stdout)).toBe(true);
  }, SLOW_PROCESS_TIMEOUT_MS);

  it("writes the same bytes for a copy with CRLF endings and a byte order mark, written to a temporary folder", () => {
    const folder = temporaryFolder();
    const text = toLf(readFileSync(join(VALID, "components.mdx"), "utf8"));
    const file = join(folder, "01-crlf.mdx");
    writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text.replaceAll("\n", "\r\n"), "utf8")]));

    const result = node(folder, file);

    expect(result.code).toBe(0);
    expect(result.stdout.equals(readFileSync(join(VALID, "components.json")))).toBe(true);
    expect(result.stdout.includes(0x0d)).toBe(false);
    expect(result.stdout.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
  });

  it("reports the same line and column for a copy with CRLF endings and a byte order mark", () => {
    const folder = temporaryFolder();
    const text = toLf(readFileSync(join(INVALID, "expression-text.mdx"), "utf8"));
    const plain = join(folder, "expression-text.mdx");
    const windows = join(folder, "expression-text-crlf.mdx");
    copyFileSync(join(INVALID, "expression-text.mdx"), plain);
    writeFileSync(windows, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text.replaceAll("\n", "\r\n"), "utf8")]));

    const a = node(folder, plain);
    const b = node(folder, windows);

    expect(a.code).toBe(1);
    expect(b.code).toBe(1);
    expect(a.stderr).toContain("expression-text.mdx:6:15: error: ");
    expect(b.stderr).toContain("expression-text-crlf.mdx:6:15: error: ");
  }, SLOW_PROCESS_TIMEOUT_MS);

  it("exits 1 for a rejected lesson, with nothing on stdout", () => {
    const result = node(PART_DIR, "fixtures\\lessons\\invalid\\import-statement.mdx");

    expect(result.code).toBe(1);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr).toBe(
      "fixtures/lessons/invalid/import-statement.mdx:6:1: error: `import` and `export` statements are not allowed in a lesson\n1 error(s), 0 warning(s)\n",
    );
  });

  it("exits 2 with the usage when there is no path or there are two", () => {
    expect(node(PART_DIR).code).toBe(2);
    expect(node(PART_DIR).stderr).toContain("usage: npm run compile -- <lesson.mdx>");
    expect(node(PART_DIR, "a.mdx", "b.mdx").code).toBe(2);
  }, SLOW_PROCESS_TIMEOUT_MS);

  it("exits 1 for a missing file", () => {
    const result = node(PART_DIR, "nowhere.mdx");

    expect(result.code).toBe(1);
    expect(result.stdout.length).toBe(0);
  });

  it("is the compile script of package.json", () => {
    const scripts = (JSON.parse(readFileSync(join(PART_DIR, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

    expect(scripts.compile).toBe("node src/compile.ts");
  });
});
