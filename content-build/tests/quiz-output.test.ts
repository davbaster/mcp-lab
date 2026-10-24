// compileQuiz and writeQuizzes: the data and the files that the backend reads.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { compileQuiz, writeQuizzes } from "../src/index.ts";
import type { CompiledQuiz } from "../src/index.ts";
import { FIRST_QUIZ, FIXTURES, PART_DIR, VALID_COURSE, courseYaml, error, makeCourse, quizFixture, temporaryFolder } from "./helpers.ts";

const GOLDEN = join(FIXTURES, "expected", "private", "quizzes", "sample-course");
const CHAPTERS = ["01-first-steps", "02-going-further"];
const TWO_OPTIONS = quizFixture("valid", "two-options-no-snippet");

/** Every file and folder under `folder`, by its path with `/`; a file maps to its text, a folder to null. */
function tree(folder: string, prefix = ""): Record<string, string | null> {
  const found: Record<string, string | null> = {};
  for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found[path] = null;
      Object.assign(found, tree(join(folder, entry.name), path));
    } else {
      found[path] = readFileSync(join(folder, entry.name), "utf8");
    }
  }
  return found;
}

function built(course = VALID_COURSE): { buildDir: string; problems: ReturnType<typeof writeQuizzes> } {
  const buildDir = join(temporaryFolder(), "build");
  return { buildDir, problems: writeQuizzes(course, buildDir) };
}

const quizOf = (text: string, lessonIds: string[] = ["01-welcome"]): CompiledQuiz => {
  const result = compileQuiz(text, { courseId: "sample-course", chapterId: "01-first-steps", lessonIds });
  if (!("quiz" in result)) throw new Error(`the quiz has problems: ${JSON.stringify(result.problems)}`);
  return result.quiz;
};

describe("compileQuiz", () => {
  it("returns the quiz data, and no problems, for a valid quiz", () => {
    const result = compileQuiz(TWO_OPTIONS, { courseId: "sample-course", chapterId: "03-tools", lessonIds: ["01-welcome"] });

    expect(Object.keys(result)).toEqual(["quiz"]);
    if (!("quiz" in result)) throw new Error("expected a quiz");
    expect(result.quiz.course_id).toBe("sample-course");
    expect(result.quiz.chapter_id).toBe("03-tools");
    expect(result.quiz.questions.map((question) => question.id)).toEqual([1, 2, 3, 4, 5].map((n) => `first-steps-${n}`));
  });

  it("returns the problems, and no quiz data, for an invalid quiz", () => {
    const result = compileQuiz("questions: []\n", { courseId: "sample-course", chapterId: "03-tools" });

    expect(result).toEqual({
      problems: [error("chapters/03-tools/quiz.yaml", "the quiz must have exactly 5 questions but has 0", 1)],
    });
  });

  it.each(["", "   ", "\u0000", "[", "{{", "- - -", ":", "questions", "questions: [", "!!binary x", "&a [*a]", "a: *nope", "\uFEFF", "null", "42", "# comment"])(
    "does not throw for the content %j",
    (text) => {
      const result = compileQuiz(text, { courseId: "sample-course", chapterId: "01-first-steps", lessonIds: ["a"] });

      expect("problems" in result).toBe(true);
    },
  );

  it("skips the lesson links without lesson IDs or with none, and checks them with some", () => {
    const options = { courseId: "sample-course", chapterId: "01-first-steps" };

    expect("quiz" in compileQuiz(TWO_OPTIONS, options)).toBe(true);
    expect("quiz" in compileQuiz(TWO_OPTIONS, { ...options, lessonIds: [] })).toBe(true);
    expect(compileQuiz(TWO_OPTIONS, { ...options, lessonIds: ["setup"] })).toMatchObject({ problems: { length: 5 } });
  });

  it("keeps the question IDs of the chapters it has seen, when it is given the map", () => {
    const options = { courseId: "sample-course", lessonIds: ["01-welcome"], questionIds: new Map() };

    expect("quiz" in compileQuiz(TWO_OPTIONS, { ...options, chapterId: "01-first-steps" })).toBe(true);
    expect(compileQuiz(TWO_OPTIONS, { ...options, chapterId: "02-going-further" })).toMatchObject({
      problems: { length: 5 },
    });
    expect(options.questionIds.get("first-steps-1")).toEqual({ file: "chapters/01-first-steps/quiz.yaml", line: 2 });
  });

  it("checks the IDs within the quiz only, without the map", () => {
    const options = { courseId: "sample-course", chapterId: "01-first-steps", lessonIds: ["01-welcome"] };

    expect("quiz" in compileQuiz(TWO_OPTIONS, options)).toBe(true);
    expect("quiz" in compileQuiz(TWO_OPTIONS, options)).toBe(true);
  });
});

describe("the data of a quiz", () => {
  const quiz = () => quizOf(quizFixture("valid", "mixed"), ["01-welcome", "setup"]);

  it("lists the fields in order, and the snippet only when the author gave one", () => {
    const [first, second] = quiz().questions;

    expect(Object.keys(quiz())).toEqual(["course_id", "chapter_id", "questions"]);
    expect(Object.keys(first!)).toEqual(["id", "text", "snippet", "options", "correct", "explanation", "lesson"]);
    expect(Object.keys(first!.snippet!)).toEqual(["language", "code"]);
    expect(Object.keys(second!)).toEqual(["id", "text", "options", "correct", "explanation", "lesson"]);
    expect(Object.keys(second!.options[0]!)).toEqual(["id", "text"]);
  });

  it("keeps the order of the questions and the options", () => {
    const { questions } = quiz();

    expect(questions.map((question) => question.id)).toEqual([1, 2, 3, 4, 5].map((n) => `first-steps-${n}`));
    expect(questions[1]!.options.map((option) => option.id)).toEqual(["a", "b", "c"]);
    expect(questions[0]!.options.map((option) => option.id)).toEqual(["a", "b"]);
  });

  it("trims the text, the option text, and the explanation, and keeps the code as it is", () => {
    const text = TWO_OPTIONS.replace("    text: Question number 1?", '    text: "  Question 1?\\n"')
      .replace("        text: Option A of question 1", '        text: "\\tOption A  "')
      .replace("    explanation: Explanation 1.", "    explanation: |\n      Explanation 1.\n      Second line.\n")
      .replace(
        "    options:",
        "    snippet:\n      language: python\n      code: |\n        def f():\n            return 1\n\n    options:",
      );
    const [first] = quizOf(text).questions;

    expect(first!.text).toBe("Question 1?");
    expect(first!.options[0]!.text).toBe("Option A");
    expect(first!.explanation).toBe("Explanation 1.\nSecond line.");
    expect(first!.snippet!.code).toBe("def f():\n    return 1\n");
  });

  it("turns CRLF into LF in every text, and writes the code with one newline at the end of a block", () => {
    const text = TWO_OPTIONS.replace("    text: Question number 1?", '    text: "A\\r\\nB"')
      .replace("    explanation: Explanation 1.", '    explanation: "C\\r\\nD\\r\\n"')
      .replace("    options:", '    snippet:\n      language: text\n      code: "x\\r\\n  y\\r\\n"\n    options:');
    const [first] = quizOf(text).questions;

    expect(first!.text).toBe("A\nB");
    expect(first!.explanation).toBe("C\nD");
    expect(first!.snippet!.code).toBe("x\n  y\n");
  });

  it("gives the same data for a quiz saved with CRLF and a byte order mark", () => {
    const plain = quizOf(quizFixture("valid", "mixed"), ["01-welcome", "setup"]);
    const windows = quizOf(`\uFEFF${quizFixture("valid", "mixed").replaceAll("\n", "\r\n")}`, ["01-welcome", "setup"]);

    expect(windows).toEqual(plain);
  });

  it("keeps non-ASCII text as it is", () => {
    const { questions } = quizOf(quizFixture("valid", "non-ascii"));

    expect(questions[0]!.text).toBe("¿Qué significa «bienvenido»?");
    expect(questions[1]!.text).toBe("日本語のテキストですか？");
    expect(questions[2]!.options[0]!.text).toBe("🌍");
  });
});

describe("the example in courses/README.md", () => {
  it("is a valid quiz for a chapter with the lessons it links to", () => {
    const readme = readFileSync(join(PART_DIR, "..", "courses", "README.md"), "utf8");
    const example = /## Quizzes[\s\S]*?```yaml\n([\s\S]*?)```/.exec(readme)?.[1];

    expect(example).toContain("questions:");
    const result = compileQuiz(example!, { courseId: "mcp-server", chapterId: "03-tools", lessonIds: ["01-intro", "02-crud"] });
    expect(result).toMatchObject({ quiz: { chapter_id: "03-tools" } });
    expect((result as { quiz: CompiledQuiz }).quiz.questions).toHaveLength(5);
  });
});

describe("writeQuizzes: the files", () => {
  it("writes the golden output byte for byte, and nothing else", () => {
    const { buildDir, problems } = built();

    expect(problems).toEqual([]);
    expect(Object.keys(tree(buildDir))).toEqual([
      "private",
      "private/quizzes",
      "private/quizzes/sample-course",
      ...CHAPTERS.map((chapter) => `private/quizzes/sample-course/${chapter}.json`),
    ]);
    for (const chapter of CHAPTERS) {
      const actual = readFileSync(join(buildDir, "private", "quizzes", "sample-course", `${chapter}.json`));
      expect(actual.equals(readFileSync(join(GOLDEN, `${chapter}.json`)))).toBe(true);
    }
  });

  it("has a golden file for each chapter and nothing else", () => {
    expect(readdirSync(GOLDEN).sort()).toEqual(CHAPTERS.map((chapter) => `${chapter}.json`));
  });

  it("writes a file with the course, the chapter, and the questions", () => {
    const { buildDir } = built();
    const file = JSON.parse(readFileSync(join(buildDir, "private", "quizzes", "sample-course", "02-going-further.json"), "utf8"));

    expect(Object.keys(file)).toEqual(["course_id", "chapter_id", "questions"]);
    expect(file.course_id).toBe("sample-course");
    expect(file.chapter_id).toBe("02-going-further");
    expect(file.questions).toHaveLength(5);
  });

  it("writes UTF-8 without a byte order mark, LF line endings, a 2-space indent, and one final newline", () => {
    const { buildDir } = built();

    for (const chapter of CHAPTERS) {
      const bytes = readFileSync(join(buildDir, "private", "quizzes", "sample-course", `${chapter}.json`));
      const text = bytes.toString("utf8");

      expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
      expect(text).not.toContain("\r");
      expect(text.endsWith("}\n")).toBe(true);
      expect(text.endsWith("\n\n")).toBe(false);
      expect(text.split("\n").slice(1, -2).every((line) => /^( {2})+\S/.test(line))).toBe(true);
      expect(text.startsWith('{\n  "course_id"')).toBe(true);
    }
  });

  it("writes non-ASCII text as it is, not as escapes", () => {
    const { buildDir } = built();
    const text = readFileSync(join(buildDir, "private", "quizzes", "sample-course", "01-first-steps.json"), "utf8");

    expect(text).toContain("¿Cómo se dice «welcome» en español? 🌍");
    expect(text).not.toMatch(/\\u[0-9a-fA-F]{4}/);
  });

  it("writes the same bytes every time, from any folder, to any build folder", () => {
    const first = built();
    const second = built(makeCourse("sample-course"));
    const again = writeQuizzes(VALID_COURSE, first.buildDir);

    expect(again).toEqual([]);
    expect(tree(second.buildDir)).toEqual(tree(first.buildDir));
  });

  it("writes the same bytes when it runs in different working folders with relative paths", () => {
    // A separate process, because a worker cannot change its working folder.
    const script = `import { writeQuizzes } from ${JSON.stringify(pathToFileURL(join(PART_DIR, "src", "index.ts")).href)};
      process.exitCode = writeQuizzes("sample-course", "out-" + process.argv[1]).length;`;
    const run = (course: string, name: string) => {
      const cwd = dirname(course);
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, name], { cwd, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return tree(join(cwd, `out-${name}`));
    };

    const first = run(makeCourse("sample-course"), "one");
    const second = run(makeCourse("sample-course"), "two");

    expect(Object.keys(first)).toHaveLength(5);
    expect(second).toEqual(first);
    expect(first).toEqual(tree(built().buildDir));
  });

  it("writes the same bytes for a quiz saved with CRLF and a byte order mark", () => {
    const quiz = readFileSync(join(VALID_COURSE, ...FIRST_QUIZ.split("/")), "utf8");
    const windows = makeCourse("sample-course", { [FIRST_QUIZ]: `\uFEFF${quiz.replaceAll("\n", "\r\n")}` });

    expect(readFileSync(join(windows, ...FIRST_QUIZ.split("/")), "utf8")).toContain("\r\n");
    expect(tree(built(windows).buildDir)).toEqual(tree(built().buildDir));
  });

  it("writes the course folder name as course_id, and handles a second course on its own", () => {
    const other = makeCourse("other-course", { "course.yaml": courseYaml({ id: "other-course" }) });
    const buildDir = join(temporaryFolder(), "build");

    expect(writeQuizzes(VALID_COURSE, buildDir)).toEqual([]);
    expect(writeQuizzes(other, buildDir)).toEqual([]);

    const folder = join(buildDir, "private", "quizzes");
    expect(readdirSync(folder).sort()).toEqual(["other-course", "sample-course"]);
    expect(JSON.parse(readFileSync(join(folder, "other-course", "01-first-steps.json"), "utf8")).course_id).toBe("other-course");
    expect(JSON.parse(readFileSync(join(folder, "sample-course", "01-first-steps.json"), "utf8")).course_id).toBe("sample-course");
  });

  it("writes a new file for every listed chapter, in a course with another chapter list", () => {
    const course = makeCourse("sample-course", {
      "course.yaml": courseYaml({ chapters: ["01-first-steps"], free_preview: [] }),
      "chapters/02-going-further": null,
    });
    const { buildDir, problems } = built(course);

    expect(problems).toEqual([]);
    expect(readdirSync(join(buildDir, "private", "quizzes", "sample-course"))).toEqual(["01-first-steps.json"]);
  });
});

describe("writeQuizzes: the build folder", () => {
  it("removes a stale file of the course, and only the course's folder", () => {
    const buildDir = join(temporaryFolder(), "build");
    const stale = join(buildDir, "private", "quizzes", "sample-course");
    const neighbour = join(buildDir, "private", "quizzes", "other-course");
    mkdirSync(stale, { recursive: true });
    mkdirSync(neighbour, { recursive: true });
    mkdirSync(join(stale, "nested"));
    writeFileSync(join(stale, "03-removed-chapter.json"), "{}\n");
    writeFileSync(join(stale, "nested", "x.json"), "{}\n");
    writeFileSync(join(neighbour, "01-a.json"), "{}\n");
    writeFileSync(join(buildDir, "unrelated.txt"), "keep\n");
    writeFileSync(join(buildDir, "private", "keep.txt"), "keep\n");

    expect(writeQuizzes(VALID_COURSE, buildDir)).toEqual([]);

    const now = tree(buildDir);
    expect(Object.keys(now).filter((path) => path.startsWith("private/quizzes/sample-course/"))).toEqual(
      CHAPTERS.map((chapter) => `private/quizzes/sample-course/${chapter}.json`),
    );
    expect(now["private/quizzes/other-course/01-a.json"]).toBe("{}\n");
    expect(now["unrelated.txt"]).toBe("keep\n");
    expect(now["private/keep.txt"]).toBe("keep\n");
  });

  it("writes nothing, and creates nothing, when a quiz has an error", () => {
    const course = makeCourse("sample-course", { [FIRST_QUIZ]: "questions: []\n" });
    const buildDir = join(temporaryFolder(), "build");

    const problems = writeQuizzes(course, buildDir);

    expect(problems).toEqual([error(FIRST_QUIZ, "the quiz must have exactly 5 questions but has 0", 1)]);
    expect(existsSync(buildDir)).toBe(false);
  });

  it("leaves an existing folder as it was when a quiz has an error", () => {
    const buildDir = join(temporaryFolder(), "build");
    expect(writeQuizzes(VALID_COURSE, buildDir)).toEqual([]);
    const before = tree(buildDir);

    const course = makeCourse("sample-course", { [`chapters/02-going-further/quiz.yaml`]: "questions: []\n" });
    const problems = writeQuizzes(course, buildDir);

    expect(problems).toHaveLength(1);
    expect(tree(buildDir)).toEqual(before);
  });

  it("writes none of the files when only one of the quizzes has an error", () => {
    const course = makeCourse("sample-course", { "chapters/02-going-further/quiz.yaml": "questions: []\n" });
    const buildDir = join(temporaryFolder(), "build");

    expect(writeQuizzes(course, buildDir)).toHaveLength(1);
    expect(existsSync(join(buildDir, "private"))).toBe(false);
  });

  it("returns the problems of every quiz, sorted, and no others", () => {
    const course = makeCourse("sample-course", {
      [FIRST_QUIZ]: "questions: []\n",
      "chapters/02-going-further/quiz.yaml": "questions: []\n",
      "course.yaml": courseYaml({ description: "" }),
    });

    expect(writeQuizzes(course, join(temporaryFolder(), "build"))).toEqual([
      error(FIRST_QUIZ, "the quiz must have exactly 5 questions but has 0", 1),
      error("chapters/02-going-further/quiz.yaml", "the quiz must have exactly 5 questions but has 0", 1),
    ]);
  });

  it("returns the problem of a chapter whose quiz.yaml is missing, and writes nothing", () => {
    const course = makeCourse("sample-course", { [FIRST_QUIZ]: null });
    const buildDir = join(temporaryFolder(), "build");

    expect(writeQuizzes(course, buildDir)).toEqual([error(FIRST_QUIZ, "quiz.yaml is missing")]);
    expect(existsSync(buildDir)).toBe(false);
  });

  it("writes the quizzes of a course that has a problem outside its quizzes", () => {
    // validateCourse reports that problem; the caller runs it first.
    const course = makeCourse("sample-course", { "course.yaml": courseYaml({ description: "" }) });
    const { buildDir, problems } = built(course);

    expect(problems).toEqual([]);
    expect(Object.keys(tree(buildDir))).toHaveLength(5);
  });

  it("returns the problems of the course, and writes nothing, when a listed chapter cannot be checked", () => {
    const course = makeCourse("sample-course", { "chapters/02-going-further": null });
    const buildDir = join(temporaryFolder(), "build");

    const problems = writeQuizzes(course, buildDir);

    expect(problems.map((problem) => problem.message)).toEqual([
      "chapter `02-going-further` is listed in `chapters` but chapters/02-going-further does not exist",
    ]);
    expect(existsSync(buildDir)).toBe(false);
  });

  it("returns the problem when there is no course folder, and writes nothing", () => {
    const buildDir = join(temporaryFolder(), "build");

    expect(writeQuizzes(join(FIXTURES, "nowhere"), buildDir)).toEqual([
      error("", "the course folder does not exist"),
    ]);
    expect(existsSync(buildDir)).toBe(false);
  });

  it("returns the problems of a course.yaml that lists no usable chapters, and writes nothing", () => {
    const course = makeCourse("sample-course", { "course.yaml": courseYaml({ chapters: "01-first-steps" }) });
    const buildDir = join(temporaryFolder(), "build");

    expect(writeQuizzes(course, buildDir).map((problem) => problem.message)).toEqual(["`chapters` must be a list"]);
    expect(existsSync(buildDir)).toBe(false);
  });

  it("refuses a course folder name that is not a valid course ID", () => {
    const course = makeCourse("Sample Course", { "course.yaml": courseYaml({ id: "Sample Course" }) });
    const buildDir = join(temporaryFolder(), "build");

    expect(writeQuizzes(course, buildDir)).toHaveLength(1);
    expect(existsSync(buildDir)).toBe(false);
  });

  it("needs a build folder", () => {
    expect(() => writeQuizzes(VALID_COURSE, " ")).toThrow("build folder");
  });
});
