// The `build` command: arguments, which courses it builds, exit codes, the problems it prints, and the all-or-nothing rule.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { PART_DIR, lessonText, temporaryFolder } from "./helpers.ts";
import { VALID_COURSES, coursesFolder, filesOf, newBuildFolder, runBuild, snapshotOf } from "./build-support.ts";

const USAGE = "usage: npm run build -- <courses folder> <build folder>";
const lastLine = (text: string) => text.trimEnd().split("\n").at(-1);
const slashes = (path: string) => path.replaceAll("\\", "/");

describe("the command line", () => {
  it.each([[[]], [["../courses"]], [["../courses", "../build", "extra"]], [["", "../build"]], [["../courses", "  "]]])(
    "prints the usage on stderr and exits 2 for %j",
    async (args) => {
      const result = await runBuild(args);

      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(USAGE);
    },
  );

  it("does not create anything when the arguments are wrong", async () => {
    const build = newBuildFolder();

    await runBuild([VALID_COURSES, build, "extra"]);

    expect(existsSync(build)).toBe(false);
  });

  it("prints built <n> course(s) into <build folder> as the last line, and exits 0", async () => {
    const build = newBuildFolder();
    const result = await runBuild([VALID_COURSES, build]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(lastLine(result.stdout)).toBe(`built 1 course(s) into ${slashes(build)}`);
  });

  it("takes folders typed with backslashes or a trailing slash, and prints them with slashes", async () => {
    const build = newBuildFolder();
    const result = await runBuild([`${VALID_COURSES}/`.replaceAll("/", "\\"), `${build}/`]);

    expect(result.code).toBe(0);
    expect(lastLine(result.stdout)).toBe(`built 1 course(s) into ${slashes(build)}`);
    expect(existsSync(join(build, "private", "courses", "sample-course.json"))).toBe(true);
  });

  it("exits 0 for a course that only has warnings, and prints them", async () => {
    const courses = coursesFolder({ "sample-course": { "notes.txt": "x" } });
    const result = await runBuild([courses, newBuildFolder()]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`${slashes(courses)}/sample-course/notes.txt: warning: this file is not part of the course format and is ignored`);
    expect(result.stdout).toContain("0 error(s), 1 warning(s)");
  });
});

describe("which courses are built", () => {
  it("builds every sub-folder of the courses folder whose name does not start with a dot, and ignores files", async () => {
    const courses = coursesFolder({ "sample-course": {}, "second-course": {} });
    writeFileSync(join(courses, "README.md"), "# Courses\n");
    mkdirSync(join(courses, ".hidden"));
    writeFileSync(join(courses, ".hidden", "junk.txt"), "x");
    const build = newBuildFolder();

    const result = await runBuild([courses, build]);

    expect(result.code).toBe(0);
    expect(lastLine(result.stdout)).toBe(`built 2 course(s) into ${slashes(build)}`);
    expect(readdirSync(join(build, "private", "courses"))).toEqual(["sample-course.json", "second-course.json"]);
  });

  it.each([[undefined], [""], ["   "], [" \t "]])("builds every course when COURSES is %j", async (value) => {
    const courses = coursesFolder({ "sample-course": {}, "second-course": {} });
    const result = await runBuild([courses, newBuildFolder()], { env: { COURSES: value } });

    expect(lastLine(result.stdout)).toMatch(/^built 2 course\(s\)/);
  });

  it("builds only the courses in COURSES, trimming each entry", async () => {
    const courses = coursesFolder({ "sample-course": {}, "second-course": {}, "third-course": {} });
    const build = newBuildFolder();

    const result = await runBuild([courses, build], { env: { COURSES: " third-course ,sample-course" } });

    expect(result.code).toBe(0);
    expect(lastLine(result.stdout)).toMatch(/^built 2 course\(s\)/);
    expect(readdirSync(join(build, "private", "courses"))).toEqual(["sample-course.json", "third-course.json"]);
  });

  it("does not check a course that COURSES leaves out", async () => {
    const courses = coursesFolder({ "sample-course": {}, "broken-course": { "course.yaml": "id: [" } });

    const result = await runBuild([courses, newBuildFolder()], { env: { COURSES: "sample-course" } });

    expect(result.code).toBe(0);
  });

  it.each([
    ["an ID with no folder", "sample-course,nope", "COURSES names `nope`, but there is no course folder "],
    ["a repeated ID", "sample-course,sample-course", "COURSES names `sample-course` more than once"],
    ["an empty entry", "sample-course,,sample-course", "COURSES has an empty entry"],
    ["an empty entry at the end", "sample-course,", "COURSES has an empty entry"],
    ["a name that points out of the folder", "../sample-course", "COURSES names `../sample-course`"],
    ["a hidden folder", ".hidden", "COURSES names `.hidden`"],
  ])("fails for %s, names the problem, and writes nothing", async (_name, value, message) => {
    const courses = coursesFolder();
    mkdirSync(join(courses, ".hidden"));
    const build = newBuildFolder();

    const result = await runBuild([courses, build], { env: { COURSES: value } });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`error: ${message}`);
    expect(existsSync(build)).toBe(false);
  });

  it("fails when COURSES names a course and the folder has none", async () => {
    const empty = join(temporaryFolder(), "courses");
    mkdirSync(empty);

    const result = await runBuild([empty, newBuildFolder()], { env: { COURSES: "mcp-server" } });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("COURSES names `mcp-server`");
  });
});

describe("problems", () => {
  it("prints every problem of every course as <path>[:<line>]: error|warning: <message>, starting at the courses folder, and exits 1", async () => {
    const courses = coursesFolder({
      "sample-course": { "chapters/01-first-steps/quiz.yaml": null },
      "second-course": { "chapters/01-first-steps/lessons/02-setup.mdx": lessonText("Setup", 0, "id: setup\n"), "notes.txt": "x" },
    });

    const result = await runBuild([courses, newBuildFolder()]);
    const prefix = slashes(courses);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd().split("\n")).toEqual([
      `${prefix}/sample-course/chapters/01-first-steps/quiz.yaml: error: quiz.yaml is missing`,
      `${prefix}/second-course/chapters/01-first-steps/lessons/02-setup.mdx:3: error: \`order\` must be 1 or more`,
      `${prefix}/second-course/notes.txt: warning: this file is not part of the course format and is ignored`,
      "2 error(s), 1 warning(s)",
    ]);
  });

  it("reports the new checks too: a duplicate lesson id and a CodeSteps tag that names a missing file", async () => {
    const courses = coursesFolder({
      "sample-course": {
        "chapters/02-going-further/lessons/02-more.mdx": lessonText("More", 2, "id: setup\n"),
        "chapters/01-first-steps/lessons/01-welcome.mdx": `${lessonText("Welcome", 1)}\n<CodeSteps step="1" file="nope.py" />\n`,
      },
    });

    const result = await runBuild([courses, newBuildFolder()]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("/sample-course/chapters/02-going-further/lessons/02-more.mdx:4: error: the lesson id `setup` is already used by ");
    expect(result.stdout).toContain("/sample-course/chapters/01-first-steps/lessons/01-welcome.mdx:8:1: error: `<CodeSteps>` shows the file `nope.py` of step 1");
  });

  it("fails when the courses folder does not exist or is a file, and names it", async () => {
    const missing = join(temporaryFolder(), "nowhere");
    const file = join(temporaryFolder(), "courses.txt");
    writeFileSync(file, "x");

    const first = await runBuild([missing, newBuildFolder()]);
    const second = await runBuild([file, newBuildFolder()]);

    expect(first.code).toBe(1);
    expect(first.stderr).toBe(`error: the courses folder ${slashes(missing)} does not exist\n`);
    expect(second.code).toBe(1);
    expect(second.stderr).toBe(`error: ${slashes(file)} is not a folder\n`);
  });

  it("exits 3, not 1, when a component schema is not valid", async () => {
    const schemas = temporaryFolder();
    writeFileSync(join(schemas, "Broken.schema.json"), "{");

    const result = await runBuild([VALID_COURSES, newBuildFolder()], { schemaDir: schemas });

    expect(result.code).toBe(3);
    expect(result.stderr).toMatch(/^build setup error: .*Broken\.schema\.json: not valid JSON/);
  });
});

describe("all or nothing", () => {
  function filled(): string {
    const build = newBuildFolder();
    for (const [path, content] of [
      ["private/courses/sample-course.json", "old manifest"],
      ["private/quizzes/sample-course/01.json", "old quiz"],
      ["public/assets/sample-course/pic-0000000000000000.png", "old picture"],
      ["assets-map/sample-course.json", "old map"],
      ["keep.txt", "keep"],
    ] as const) {
      mkdirSync(dirname(join(build, path)), { recursive: true });
      writeFileSync(join(build, path), content);
    }
    mkdirSync(join(build, "private", "empty-folder"));
    return build;
  }

  it("leaves a build folder byte for byte as it was when a course has an error", async () => {
    const courses = coursesFolder({ "sample-course": {}, "second-course": { "chapters/01-first-steps/quiz.yaml": "questions: []\n" } });
    const build = filled();
    const before = snapshotOf(build);

    const result = await runBuild([courses, build]);

    expect(result.code).toBe(1);
    expect(snapshotOf(build)).toEqual(before);
    expect(Object.keys(before.files)).toHaveLength(5);
  });

  it("does not write the good course when another course is bad", async () => {
    const courses = coursesFolder({ "sample-course": {}, "second-course": { "course.yaml": "id: [" } });
    const build = newBuildFolder();

    expect((await runBuild([courses, build])).code).toBe(1);

    expect(existsSync(build)).toBe(false);
  });

  it("leaves the build folder alone when only a warning-free, valid course is selected but the folder cannot be used", async () => {
    const courses = coursesFolder();
    const build = filled();
    const before = snapshotOf(build);

    for (const unusable of [courses, dirname(courses), join(courses, "sample-course"), join(courses, "new-build")]) {
      const result = await runBuild([courses, unusable]);
      expect(result.code, unusable).toBe(1);
      expect(result.stderr, unusable).toMatch(/^error: the build folder must not /);
    }

    expect(snapshotOf(build)).toEqual(before);
    expect(existsSync(join(courses, "new-build"))).toBe(false);
    expect(existsSync(join(courses, "private"))).toBe(false);
  });

  it("refuses a build folder that is a file", async () => {
    const file = join(temporaryFolder(), "build");
    writeFileSync(file, "x");

    const result = await runBuild([VALID_COURSES, file]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("the build folder is a file, not a folder");
    expect(readFileSync(file, "utf8")).toBe("x");
  });

  it("refuses a build folder whose path reaches the courses folder through ..", async () => {
    const courses = coursesFolder();

    const result = await runBuild([courses, join(courses, "sample-course", "..", "inside")]);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^error: the build folder must not be the courses folder or inside it/);
  });
});

describe("no course at all", () => {
  it("exits 0, says so, prints the built 0 line, and still creates private/ and public/", async () => {
    const empty = join(temporaryFolder(), "courses");
    mkdirSync(empty);
    writeFileSync(join(empty, "README.md"), "# Courses\n");
    const build = newBuildFolder();

    const result = await runBuild([empty, build]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`no courses found in ${slashes(empty)}\nbuilt 0 course(s) into ${slashes(build)}\n`);
    expect(readdirSync(build).sort()).toEqual(["private", "public"]);
  });

  it("clears the output of earlier builds", async () => {
    const empty = join(temporaryFolder(), "courses");
    mkdirSync(empty);
    const build = newBuildFolder();
    expect((await runBuild([VALID_COURSES, build])).code).toBe(0);

    expect((await runBuild([empty, build])).code).toBe(0);

    expect([...filesOf(build).keys()]).toEqual([]);
  });
});

describe("the real command", () => {
  // Runs the same thing as `npm run build -- <courses> <build>` (node src/build.ts), in a separate process.
  function node(cwd: string, ...args: string[]) {
    const result = spawnSync(process.execPath, [join(PART_DIR, "src", "build.ts"), ...args], { cwd, encoding: "utf8", env: { ...process.env, COURSES: "" } });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("builds the valid fixture, reads COURSES from the environment, and exits 0", () => {
    const build = newBuildFolder();
    const result = node(PART_DIR, "fixtures/valid", build);

    expect(result.code).toBe(0);
    expect(lastLine(result.stdout)).toBe(`built 1 course(s) into ${slashes(build)}`);
    expect(existsSync(join(build, "private", "lessons", "sample-course", "setup.json"))).toBe(true);
  });

  it("exits 1 with the problems on stdout for a course with errors, and 2 without arguments", () => {
    const failed = node(PART_DIR, "fixtures/invalid", newBuildFolder());
    const usage = node(PART_DIR);

    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain("fixtures/invalid/asset-empty-file/assets/images/empty.png: error: the file is empty (0 bytes)");
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain(USAGE);
  });
});
