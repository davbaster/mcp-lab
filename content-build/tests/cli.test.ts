// The `validate` command: output format, ordering, exit codes, and paths typed either way.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { FIXTURES, PART_DIR, courseYaml, lessonText, makeCourse } from "./helpers.ts";

function run(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = main(args, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) });
  return { code, stdout, stderr };
}

describe("a valid course", () => {
  it("prints only the summary and exits 0", () => {
    expect(run("fixtures/valid/sample-course")).toEqual({
      code: 0,
      stdout: "0 error(s), 0 warning(s)\n",
      stderr: "",
    });
  });
});

describe("a course with errors", () => {
  it("prints one line per problem and the summary last, and exits 1", () => {
    const result = run("fixtures/invalid/lesson-order-gap");

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      "fixtures/invalid/lesson-order-gap/chapters/01-intro/lessons: error: `order` values must be unique and run from 1 to 2 with no gaps, but they are 1, 3\n" +
        "1 error(s), 0 warning(s)\n",
    );
  });

  it("includes the line number when the problem has one", () => {
    const { stdout } = run("fixtures/invalid/title-wrong-type");

    expect(stdout.split("\n")[0]).toBe("fixtures/invalid/title-wrong-type/course.yaml:2: error: `title` must be a string");
  });

  it("reports every problem in one run, sorted by path and then message", () => {
    const course = makeCourse("sample-course", {
      "course.yaml": courseYaml({ description: "" }),
      "z-notes.txt": "x",
      "chapters/01-first-steps/quiz.yaml": null,
      "chapters/02-going-further/lessons/01-next.mdx": lessonText("Next", 0),
      "chapters/02-going-further/lessons/02-two.mdx": "no front matter",
    });

    const lines = run(course).stdout.trimEnd().split("\n");
    const prefix = course.replaceAll("\\", "/");

    expect(lines).toEqual([
      `${prefix}/chapters/01-first-steps/quiz.yaml: error: quiz.yaml is missing`,
      `${prefix}/chapters/02-going-further/lessons/01-next.mdx:3: error: \`order\` must be 1 or more`,
      `${prefix}/chapters/02-going-further/lessons/02-two.mdx:1: error: the lesson must start with a front-matter block: a \`---\` line, the settings, and a closing \`---\` line`,
      `${prefix}/course.yaml:4: error: \`description\` must not be empty`,
      `${prefix}/z-notes.txt: warning: this file is not part of the course format and is ignored`,
      "4 error(s), 1 warning(s)",
    ]);
  });

  it("prints the same output when the path is typed with backslashes", () => {
    const slashes = run("fixtures/invalid/lesson-order-duplicate");
    const backslashes = run("fixtures\\invalid\\lesson-order-duplicate");

    expect(backslashes).toEqual(slashes);
    expect(backslashes.stdout).not.toContain("\\");
    expect(backslashes.stdout.startsWith("fixtures/invalid/lesson-order-duplicate/")).toBe(true);
  });

  it("accepts a trailing slash and prints the path as given", () => {
    const { stdout } = run("./fixtures/invalid/missing-title/");

    expect(stdout.split("\n")[0]).toBe("./fixtures/invalid/missing-title/course.yaml: error: missing required field `title`");
  });
});

describe("a course with only warnings", () => {
  it("exits 0 and counts the warnings", () => {
    const result = run("fixtures/warnings/chapter-in-progress");

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      "fixtures/warnings/chapter-in-progress/chapters/02-later: warning: this chapter folder has only code/, so it is a chapter in progress: it is not listed in `chapters` and is not built\n" +
        "0 error(s), 1 warning(s)\n",
    );
  });
});

describe("a bad command line", () => {
  it("fails with a message when the path does not exist", () => {
    const result = run("fixtures/valid/no-such-course");

    expect(result.code).toBe(1);
    expect(result.stdout).toBe(
      "fixtures/valid/no-such-course: error: the course folder does not exist\n1 error(s), 0 warning(s)\n",
    );
  });

  it("fails with a message when the path is a file", () => {
    const result = run(join("fixtures", "valid", "sample-course", "course.yaml"));

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("error: the path is not a folder");
  });

  it("fails with the usage when no path is given", () => {
    const result = run();

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("give the course folder");
    expect(result.stderr).toContain("npm run validate -- <course folder>");
  });

  it("fails with the usage when the path is blank or there are two", () => {
    expect(run("  ").code).not.toBe(0);
    expect(run("a", "b").code).not.toBe(0);
  });
});

describe("the real command", () => {
  // Runs the same thing as `npm run validate -- <path>` (node src/validate.ts), in a separate process,
  // so Node's type stripping, the entry-point check, and the exit code are all exercised.
  function node(...args: string[]) {
    const result = spawnSync(process.execPath, [join(PART_DIR, "src", "validate.ts"), ...args], {
      cwd: PART_DIR,
      encoding: "utf8",
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("exits 0 on the valid fixture, with the output on stdout only", () => {
    expect(node("fixtures/valid/sample-course")).toEqual({ code: 0, stdout: "0 error(s), 0 warning(s)\n", stderr: "" });
  });

  it("exits non-zero on an invalid fixture and prints the problems on stdout", () => {
    const result = node("fixtures\\invalid\\missing-title");

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      "fixtures/invalid/missing-title/course.yaml: error: missing required field `title`\n1 error(s), 0 warning(s)\n",
    );
  });

  it("exits non-zero with a message when there is no path", () => {
    const result = node();

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage:");
  });

  it("exits non-zero when the path does not exist", () => {
    expect(node(join(FIXTURES, "nowhere")).code).toBe(1);
  });
});
