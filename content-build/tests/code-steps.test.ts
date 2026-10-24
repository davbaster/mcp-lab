// The checks on code/ folders: step structure, files, limits. Each rejection checks the exact problem
// and that the `validate` command prints it. Cases git cannot keep (generated folders, links, binary
// files, CRLF, size limits) are made in a temporary folder by the test.

import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { CODE_LIMITS, stepPathProblems } from "../src/code-steps.ts";
import { inspectCourse, validateCourse } from "../src/course.ts";
import { formatProblem } from "../src/problem.ts";
import type { Problem } from "../src/problem.ts";
import { CODE, FIXTURES, PART_DIR, VALID_COURSE, canCreate, codeCourse, error, makeCourse, temporaryFolder, warning } from "./helpers.ts";

const STEP_1 = `${CODE}/step-1`;
const NOT_A_STEP =
  "this is not a step folder; code/ holds only folders named step-1, step-2, and so on (`step-` and a whole number with no leading zero, spelled exactly like that)";
const NOT_COMMITTED = "this must not be committed: it is generated or installed, not part of the step";
const NOT_PLAIN = "this is not a plain file or folder (for example, a symbolic link), and the build never follows links";
const missing = (n: number) => `\`step-${n}\` is missing; steps must be numbered 1, 2, 3, and so on with no gaps`;
const WINDOWS = "this path cannot be extracted on Windows: ";

/** Runs the `validate` command in this process and returns what it printed. */
function validate(course: string) {
  let stdout = "";
  const code = main([course], { stdout: (text) => (stdout += text), stderr: () => {} });
  return { code, lines: stdout.trimEnd().split("\n") };
}

/** The course has exactly these problems, and the `validate` command prints each of them. */
function expectProblems(course: string, expected: Problem[]) {
  expect(validateCourse(course)).toEqual(expected);
  const { code, lines } = validate(course);
  const errors = expected.filter((problem) => problem.severity === "error").length;
  expect(lines).toEqual([...expected.map((problem) => formatProblem(course, problem)), `${errors} error(s), ${expected.length - errors} warning(s)`]);
  expect(code).toBe(errors > 0 ? 1 : 0);
}

function symlinksWork(): boolean {
  const folder = temporaryFolder();
  try {
    writeFileSync(join(folder, "target"), "x");
    symlinkSync(join(folder, "target"), join(folder, "link"));
    return true;
  } catch {
    return false;
  }
}
const canLink = symlinksWork();

describe("which chapters are checked", () => {
  it("checks every listed chapter that has a code/ folder", () => {
    const course = makeCourse("sample-course", { "chapters/02-going-further/code/step-2/main.py": "x = 1\n" });

    expectProblems(course, [error("chapters/02-going-further/code", missing(1))]);
  });

  it("checks an unlisted chapter that has only code/, and keeps the warning about it", () => {
    const course = makeCourse("sample-course", { "chapters/03-later/code/step-2/main.py": "x = 1\n" });

    expectProblems(course, [
      warning(
        "chapters/03-later",
        "this chapter folder has only code/, so it is a chapter in progress: it is not listed in `chapters` and is not built",
      ),
      error("chapters/03-later/code", missing(1)),
    ]);
  });

  it("accepts a valid unlisted chapter in progress with only the warning", () => {
    const course = makeCourse("sample-course", { "chapters/03-later/code/step-1/main.py": "x = 1\n" });

    expect(validateCourse(course).map((problem) => problem.severity)).toEqual(["warning"]);
  });

  it("accepts a chapter with no code/ folder", () => {
    expect(validateCourse(makeCourse("sample-course"))).toEqual([]);
    expect(inspectCourse(makeCourse("sample-course")).code?.chapters.map((chapter) => chapter.chapter_id)).toEqual(["01-first-steps"]);
  });

  it("warns about a code that is a file and ignores it", () => {
    const course = makeCourse("sample-course", { "chapters/02-going-further/code": "not a folder" });

    expectProblems(course, [warning("chapters/02-going-further/code", "`code` should be a folder and is ignored")]);
  });
});

describe("step folder names", () => {
  it.each(["step-01", "step-0", "step-", "step-1a", "step_1", "steps", "draft", "step-1.bak"])(
    "rejects a folder named %s",
    (name) => {
      const course = codeCourse({ "step-1/main.py": "x = 1\n", [`${name}/main.py`]: "x = 1\n" });

      expectProblems(course, [error(`${CODE}/${name}`, NOT_A_STEP)]);
    },
  );

  // With step-1 gone, Step-1 is a different name on every file system, so these run everywhere.
  it.each(["Step-1", "STEP-1"])("rejects a folder named %s when it is the only step folder", (name) => {
    const course = codeCourse({ [`${name}/main.py`]: "x = 1\n" });

    expectProblems(course, [error(CODE, missing(1)), error(`${CODE}/${name}`, NOT_A_STEP)]);
  });

  // Beside step-1, a file system that ignores letter case cannot hold both folders (the rule for case-only names is in windows-paths.test.ts).
  for (const name of ["Step-1", "STEP-1"]) {
    it.skipIf(!canCreate("step-1/main.py", `${name}/main.py`))(`rejects a folder named ${name} beside step-1 [needs a file system that tells letter case apart]`, () => {
      const course = codeCourse({ "step-1/main.py": "x = 1\n", [`${name}/main.py`]: "x = 1\n" });

      expectProblems(course, [error(`${CODE}/${name}`, NOT_A_STEP)]);
    });
  }

  it("rejects a file in code/, whatever its name", () => {
    const course = codeCourse({ "step-1/main.py": "x = 1\n", "README.md": "# Notes\n", "step-2": "not a folder" });

    expectProblems(course, [error(`${CODE}/README.md`, NOT_A_STEP), error(`${CODE}/step-2`, "a step must be a folder, but this is a file")]);
  });

  it("rejects a name that differs only in case from a good step, even on a case-insensitive file system", () => {
    // The name is looked up in the folder listing, so it is never opened by the name typed here.
    const course = codeCourse({ "Step-2/main.py": "x = 1\n", "step-1/main.py": "x = 1\n" });

    expectProblems(course, [error(`${CODE}/Step-2`, NOT_A_STEP)]);
  });

  it("accepts step-10 and larger numbers written without a leading zero", () => {
    const files: Record<string, string> = {};
    for (let n = 1; n <= 12; n++) files[`step-${n}/main.py`] = `x = ${n}\n`;

    expect(validateCourse(codeCourse(files))).toEqual([]);
  });
});

describe("gaps", () => {
  it("fails when a step is missing between two others", () => {
    const course = codeCourse({ "step-1/main.py": "x = 1\n", "step-3/main.py": "x = 3\n" });

    expectProblems(course, [error(CODE, missing(2))]);
  });

  it("fails when there is no step-1", () => {
    const course = codeCourse({ "step-2/main.py": "x = 2\n" });

    expectProblems(course, [error(CODE, missing(1))]);
  });

  it("fails for a code/ folder with no step folders", () => {
    const course = codeCourse({}, { [`${CODE}/.gitkeep`]: "" });

    expectProblems(course, [error(CODE, missing(1)), error(`${CODE}/.gitkeep`, NOT_A_STEP)]);
  });

  it("names only the first missing step", () => {
    const course = codeCourse({ "step-1/main.py": "x", "step-5/main.py": "x", "step-9/main.py": "x" });

    expectProblems(course, [error(CODE, missing(2))]);
  });

  it("does not count a huge step number as a reason to list a million gaps", () => {
    const course = codeCourse({ "step-1/main.py": "x", "step-99999999999999999999999/main.py": "x" });

    expectProblems(course, [error(CODE, missing(2))]);
  });
});

describe("files in a step", () => {
  it("fails for a step with no files, at any depth, and names the step folder", () => {
    const course = codeCourse({ "step-1/main.py": "x" });
    mkdirSync(join(course, ...CODE.split("/"), "step-2", "empty", "deeper"), { recursive: true });

    expectProblems(course, [error(`${CODE}/step-2`, "this step has no files")]);
  });

  it("does not count OS files as files, and neither reads nor ships them", () => {
    const course = codeCourse({
      "step-1/main.py": "x = 1\n",
      "step-1/.DS_Store": "\u0000\u0001binary",
      "step-1/src/Thumbs.db": "\u0000",
      "step-2/.DS_Store": "x",
    });

    expectProblems(course, [error(`${CODE}/step-2`, "this step has no files")]);
    const fixed = codeCourse({ "step-1/main.py": "x = 1\n", "step-1/.DS_Store": "\u0000", "step-1/src/Thumbs.db": "\u0000" });
    const chapter = inspectCourse(fixed).code?.chapters[0];
    expect([...(chapter?.steps[0]?.files.keys() ?? [])]).toEqual(["main.py"]);
  });

  it("accepts an empty file, which has no text", () => {
    const course = codeCourse({ "step-1/__init__.py": "", "step-1/main.py": "x" });

    expect(validateCourse(course)).toEqual([]);
    expect(inspectCourse(course).code?.chapters[0]?.steps[0]?.files.get("__init__.py")).toBe("");
  });

  it("fails for a file that is not valid UTF-8, and names the file", () => {
    const course = codeCourse({ "step-1/main.py": "x", "step-1/data.bin": Uint8Array.of(0x53, 0xff, 0xfe, 0x00, 0x80) });

    expectProblems(course, [error(`${STEP_1}/data.bin`, "the file is not valid UTF-8")]);
  });

  it("fails for a file with a NUL character that decodes as UTF-8", () => {
    const course = codeCourse({ "step-1/main.py": "x", "step-1/src/odd.txt": "text\u0000more" });

    expectProblems(course, [error(`${STEP_1}/src/odd.txt`, "the file contains a NUL character, so it is not text")]);
  });

  it("fails for UTF-16 text, which has NUL characters or invalid UTF-8", () => {
    const utf16 = Buffer.from("﻿print('hi')\n", "utf16le");
    const course = codeCourse({ "step-1/main.py": utf16 });

    expect(validateCourse(course)).toHaveLength(1);
    expect(validateCourse(course)[0]?.file).toBe(`${STEP_1}/main.py`);
  });

  it("never quotes the content of a file in a problem", () => {
    const course = codeCourse({
      "step-1/ok.py": "x",
      "step-1/binary.bin": Buffer.concat([Buffer.from("SECRET-SENTINEL-9c1f "), Uint8Array.of(0xff)]),
      "step-1/zero.txt": "SECRET-SENTINEL-9c1f\u0000",
      "step-1/big.txt": `SECRET-SENTINEL-9c1f${"a".repeat(CODE_LIMITS.maxFileBytes)}`,
    });
    const problems = validateCourse(course);

    expect(problems).toHaveLength(3);
    expect(JSON.stringify(problems)).not.toContain("SECRET-SENTINEL");
    expect(validate(course).lines.join("\n")).not.toContain("SECRET-SENTINEL");
  });

  it("accepts CRLF, a byte order mark, and a lone CR", () => {
    const course = codeCourse({ "step-1/main.py": "﻿a\r\nb\rc\r\n" });

    expect(validateCourse(course)).toEqual([]);
    expect(inspectCourse(course).code?.chapters[0]?.steps[0]?.files.get("main.py")).toBe("a\nb\rc\n");
  });
});

describe("generated files", () => {
  it.each(["__pycache__", ".venv", "node_modules", ".pytest_cache"])("fails for a folder named %s at any depth, and does not look inside", (name) => {
    const course = codeCourse({
      "step-1/main.py": "x",
      [`step-1/${name}/inside.py`]: "x",
      [`step-1/${name}/deeper/binary.bin`]: Uint8Array.of(0xff),
      [`step-2/src/${name}/x.txt`]: "x",
      "step-2/src/main.py": "x",
    });

    expectProblems(course, [error(`${STEP_1}/${name}`, NOT_COMMITTED), error(`${CODE}/step-2/src/${name}`, NOT_COMMITTED)]);
  });

  it.each(["__pycache__", ".venv", "node_modules", ".pytest_cache"])("fails for a file named %s too", (name) => {
    const course = codeCourse({ "step-1/main.py": "x", [`step-1/${name}`]: "x" });

    expectProblems(course, [error(`${STEP_1}/${name}`, NOT_COMMITTED)]);
  });

  it("fails for a .pyc file, in any folder, with any case of the folder name left alone", () => {
    const course = codeCourse({ "step-1/main.py": "x", "step-1/main.cpython-312.pyc": "x", "step-1/src/util.pyc": "x", "step-1/PYC": "x" });

    expectProblems(course, [error(`${STEP_1}/main.cpython-312.pyc`, NOT_COMMITTED), error(`${STEP_1}/src/util.pyc`, NOT_COMMITTED)]);
  });

  it("accepts a name that only contains a forbidden name", () => {
    const course = codeCourse({ "step-1/main.py": "x", "step-1/my__pycache__": "x", "step-1/node_modules.txt": "x", "step-1/.venv2/a.py": "x", "step-1/pyc": "x" });

    expect(validateCourse(course)).toEqual([]);
  });
});

describe("entries that are not plain files or folders", () => {
  it.skipIf(!canLink)("fails for a symbolic link to a file outside the course, without reading it", () => {
    const outside = join(temporaryFolder(), "outside.txt");
    writeFileSync(outside, "OUTSIDE-SENTINEL-77\n");
    const course = codeCourse({ "step-1/main.py": "x" });
    symlinkSync(outside, join(course, ...STEP_1.split("/"), "link.txt"));

    expectProblems(course, [error(`${STEP_1}/link.txt`, NOT_PLAIN)]);
    expect(JSON.stringify(inspectCourse(course))).not.toContain("OUTSIDE-SENTINEL");
  });

  it.skipIf(!canLink)("fails for a symbolic link to a folder, and does not go into it", () => {
    const outside = temporaryFolder();
    writeFileSync(join(outside, "secret.py"), "x");
    writeFileSync(join(outside, "binary.bin"), Uint8Array.of(0xff));
    const course = codeCourse({ "step-1/main.py": "x" });
    symlinkSync(outside, join(course, ...STEP_1.split("/"), "linked"), "dir");

    expectProblems(course, [error(`${STEP_1}/linked`, NOT_PLAIN)]);
  });

  it.skipIf(!canLink)("fails for a link that points back at its own folder, and for a broken link", () => {
    const course = codeCourse({ "step-1/main.py": "x" });
    const step = join(course, ...STEP_1.split("/"));
    symlinkSync(".", join(step, "loop"), "dir");
    symlinkSync("does-not-exist", join(step, "broken.py"));

    expectProblems(course, [error(`${STEP_1}/broken.py`, NOT_PLAIN), error(`${STEP_1}/loop`, NOT_PLAIN)]);
  });

  it.skipIf(!canLink)("fails for a step that is a symbolic link to a folder", () => {
    const outside = temporaryFolder();
    writeFileSync(join(outside, "main.py"), "x");
    const course = codeCourse({ "step-1/main.py": "x" });
    symlinkSync(outside, join(course, ...CODE.split("/"), "step-2"), "dir");

    expectProblems(course, [error(`${CODE}/step-2`, "a step must be a folder, but this is not a folder")]);
  });

  it.skipIf(!canLink)("fails for a link in a file that is named like a generated one, with the generated message", () => {
    const course = codeCourse({ "step-1/main.py": "x" });
    symlinkSync("main.py", join(course, ...STEP_1.split("/"), "util.pyc"));

    expectProblems(course, [error(`${STEP_1}/util.pyc`, NOT_PLAIN)]);
  });

  it.skipIf(process.platform === "win32")("fails for a named pipe", () => {
    const course = codeCourse({ "step-1/main.py": "x" });
    const made = spawnSync("mkfifo", [join(course, ...STEP_1.split("/"), "pipe")]);
    if (made.status !== 0) return;

    expectProblems(course, [error(`${STEP_1}/pipe`, NOT_PLAIN)]);
  });
});

describe("paths that Windows cannot extract", () => {
  const CHARACTER = `${WINDOWS}the name has a character that Windows does not allow in file names (one of < > : " \\ | ? * or a control character)`;
  const CASE = (other: string) => `${WINDOWS}\`${other}\` in the same folder differs only in letter case, and Windows and macOS keep only one of them`;
  const BAD_NAMES = ["ok.py", "bad|name.py", "ends.", "ends ", "src/NUL.txt", "Util.py", "util.py"];
  const BAD_NAME_PROBLEMS = [
    error(`${STEP_1}/Util.py`, CASE("util.py")),
    error(`${STEP_1}/bad|name.py`, CHARACTER),
    error(`${STEP_1}/ends `, `${WINDOWS}the name ends with a space or a dot, which Windows removes`),
    error(`${STEP_1}/ends.`, `${WINDOWS}the name ends with a space or a dot, which Windows removes`),
    error(
      `${STEP_1}/src/NUL.txt`,
      `${WINDOWS}the name is a Windows device name (CON, PRN, AUX, NUL, COM1 to COM9, LPT1 to LPT9), alone or with an extension`,
    ),
    error(`${STEP_1}/util.py`, CASE("Util.py")),
  ];

  // The rule on path strings runs on every platform; the tests that write the files run where the file system can hold the names.
  it("fails, on path strings, for a bad character, a trailing dot or space, a device name, and a case-only difference", () => {
    expect(stepPathProblems(BAD_NAMES, STEP_1)).toEqual(BAD_NAME_PROBLEMS);
  });

  it("fails once, on path strings, for a bad folder name, however many files are in it", () => {
    expect(stepPathProblems(["what?/a.py", "what?/b.py"], STEP_1)).toEqual([error(`${STEP_1}/what?`, CHARACTER)]);
  });

  it("fails, on path strings, for a path of 101 characters and accepts 100", () => {
    const hundred = "d".repeat(100);

    expect(stepPathProblems([hundred], STEP_1)).toEqual([]);
    expect(stepPathProblems([`${hundred}z`], STEP_1)).toEqual([error(`${STEP_1}/${hundred}z`, `${WINDOWS}it is 101 characters long and the most allowed is 100`)]);
  });

  it.skipIf(!canCreate(...BAD_NAMES.map((name) => `step-1/${name}`)))(
    "fails on disk for a bad character, a trailing dot or space, a device name, and a case-only difference [needs a file system that can create these names]",
    () => {
      const course = codeCourse(Object.fromEntries(BAD_NAMES.map((name) => [`step-1/${name}`, "x"])));

      expectProblems(course, BAD_NAME_PROBLEMS);
    },
  );

  it.skipIf(!canCreate("step-1/what?/a.py"))("fails on disk once for a bad folder name, however many files are in it [needs a file system that can create `what?`]", () => {
    const course = codeCourse({ "step-1/what?/a.py": "x", "step-1/what?/b.py": "x" });

    expectProblems(course, [error(`${STEP_1}/what?`, CHARACTER)]);
  });

  it("fails for a path of 101 characters inside the step, and accepts 100", () => {
    const hundred = `${"d".repeat(48)}/${"f".repeat(48)}.py`.padEnd(100, "y");
    const long = `${hundred}z`;
    expect(hundred).toHaveLength(100);

    expect(validateCourse(codeCourse({ [`step-1/${hundred}`]: "x" }))).toEqual([]);
    expectProblems(codeCourse({ [`step-1/${long}`]: "x" }), [
      error(`${STEP_1}/${long}`, `${WINDOWS}it is 101 characters long and the most allowed is 100`),
    ]);
  });
});

describe("limits", () => {
  it("sets the numbers in one constant", () => {
    expect(CODE_LIMITS).toEqual({ maxSteps: 20, maxFilesPerStep: 100, maxFileBytes: 262_144, maxPathLength: 100 });
  });

  it("accepts 20 steps and fails for 21, naming the chapter", () => {
    const steps = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`step-${i + 1}/main.py`, `x = ${i}\n`]));

    expect(validateCourse(codeCourse(steps(20)))).toEqual([]);
    expectProblems(codeCourse(steps(21)), [error(CODE, "chapter `01-first-steps` has 21 steps, but the most allowed is 20")]);
  });

  it("accepts 100 files in a step and fails for 101, naming the step", () => {
    const files = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`step-1/f${i}.txt`, "x"]));

    expect(validateCourse(codeCourse(files(100)))).toEqual([]);
    expectProblems(codeCourse(files(101)), [error(STEP_1, "this step has 101 files, but the most allowed is 100")]);
  });

  it("counts files at every depth", () => {
    const files = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`step-1/d${i % 3}/f${i}.txt`, "x"]));

    expectProblems(codeCourse(files), [error(STEP_1, "this step has 101 files, but the most allowed is 100")]);
  });

  it("accepts a file of 262,144 bytes and fails for one byte more, naming the file", () => {
    const course = (size: number) => codeCourse({ "step-1/main.py": "x", "step-1/big.txt": "a".repeat(size) });

    expect(validateCourse(course(262_144))).toEqual([]);
    expectProblems(course(262_145), [error(`${STEP_1}/big.txt`, "the file is 262145 bytes, but the most allowed is 262144 bytes (256 KiB)")]);
  });

  it("counts the bytes on disk, not the characters or the lines after normalizing", () => {
    // 131,072 two-byte characters are exactly 262,144 bytes; with a BOM and CRLF the file is bigger.
    expect(validateCourse(codeCourse({ "step-1/a.txt": "é".repeat(131_072) }))).toEqual([]);
    expect(validateCourse(codeCourse({ "step-1/a.txt": `\uFEFF${"é".repeat(131_072)}` }))).toHaveLength(1);
    expect(validateCourse(codeCourse({ "step-1/a.txt": "\r\n".repeat(131_073) }))).toHaveLength(1);
  });
});

describe("a bad step", () => {
  it("does not stop the other chapters from being checked, and all problems come sorted in one run", () => {
    const course = makeCourse("sample-course", {
      [CODE]: null,
      [`${CODE}/step-1/main.py`]: "x",
      [`${CODE}/step-3/main.py`]: "x",
      [`${CODE}/step-1/__pycache__/x.pyc`]: "x",
      "chapters/02-going-further/code/step-1/main.py": Uint8Array.of(0xff),
      "chapters/03-later/code/draft/x.py": "x",
    });

    expectProblems(course, [
      warning("chapters/03-later", "this chapter folder has only code/, so it is a chapter in progress: it is not listed in `chapters` and is not built"),
      error(CODE, missing(2)),
      error(`${STEP_1}/__pycache__`, NOT_COMMITTED),
      error("chapters/02-going-further/code/step-1/main.py", "the file is not valid UTF-8"),
      error("chapters/03-later/code", missing(1)),
      error("chapters/03-later/code/draft", NOT_A_STEP),
    ].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || (a.message < b.message ? -1 : 1)));
  });

  it("reports the problems of every step of one chapter, not only the first", () => {
    const course = codeCourse({
      "step-1/a.bin": Uint8Array.of(0xff),
      "step-2/a.txt": "nul\u0000",
      "step-3/node_modules/x": "x",
      "step-3/main.py": "x",
    });

    expect(validateCourse(course).map((problem) => problem.file)).toEqual([
      `${CODE}/step-1/a.bin`,
      `${CODE}/step-2/a.txt`,
      `${CODE}/step-3/node_modules`,
    ]);
  });
});

describe("what inspectCourse returns for the next steps", () => {
  it("lists the step numbers and the file paths of each listed chapter with valid steps", () => {
    const { code } = inspectCourse(VALID_COURSE);

    expect(code?.problems).toEqual([]);
    expect(code?.chapters.map((chapter) => [chapter.chapter_id, chapter.steps.map((step) => [step.step, [...step.files.keys()]])])).toEqual([
      [
        "01-first-steps",
        [
          [1, ["helper.py", "main.py", "settings.txt"]],
          [2, ["helper.py", "main.py", "pkg/__init__.py", "pkg/util.py", "settings.txt"]],
          [3, ["main.py", "pkg/__init__.py", "pkg/util.py", "settings.txt"]],
        ],
      ],
    ]);
  });

  it("leaves out a chapter whose steps have a problem, and an unlisted chapter", () => {
    const course = makeCourse("sample-course", {
      "chapters/02-going-further/code/step-1/main.py": "x",
      "chapters/02-going-further/code/step-3/main.py": "x",
      "chapters/03-later/code/step-1/main.py": "x",
    });
    const { code } = inspectCourse(course);

    expect(code?.chapters.map((chapter) => chapter.chapter_id)).toEqual(["01-first-steps"]);
    expect(code?.problems).toEqual([error("chapters/02-going-further/code", missing(2))]);
  });
});

describe("the real command", () => {
  it("prints a code problem and exits 1, in a separate process", () => {
    const course = codeCourse({ "step-1/main.py": "x", "step-3/main.py": "x" });
    const result = spawnSync(process.execPath, [join(PART_DIR, "src", "validate.ts"), course], { cwd: FIXTURES, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe(`${course.replaceAll("\\", "/")}/${CODE}: error: ${missing(2)}\n1 error(s), 0 warning(s)\n`);
  });
});
