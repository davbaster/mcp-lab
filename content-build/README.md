# content-build

A Node + TypeScript tool that validates the courses in `courses/` and compiles their restricted MDX to JSON. So far it validates the folder layout, `course.yaml`, the lesson front matter, and each chapter's `quiz.yaml`, and it compiles the quizzes to JSON. The format is described in [`courses/README.md`](../courses/README.md).

It needs Node 24 (the version in the root `.nvmrc`). The scripts run `.ts` files with Node's built-in type stripping, so no TypeScript runner is installed, `engines.node` is `>=24`, and the code uses only erasable TypeScript syntax (`erasableSyntaxOnly` in `tsconfig.json`: no enums, namespaces, or constructor parameter properties). Imports of local files end in `.ts`.

## Commands

Run from the repo root with `make install-content-build`, `make lint-content-build`, `make typecheck-content-build`, and `make test-content-build`, or in this folder:

- `npm ci` - install
- `npm test` - the tests (Vitest, single run)
- `npm run lint` - ESLint
- `npm run typecheck` - `tsc --noEmit`
- `npm run validate -- <course folder>` - check one course folder, for example `npm run validate -- fixtures/valid/sample-course` (the path may use `/` or `\`)

`validate` prints each problem on its own line, on stdout, as `<path>[:<line>]: error: <message>` or `<path>[:<line>]: warning: <message>`, then `N error(s), M warning(s)`. `<path>` is the course path as given plus the file's path inside the course, always with `/`. All problems come in one run, sorted by path and then message. The exit code is 1 if there is an error, 0 otherwise (2 when no path is given).

## Using it from code

```ts
import { validateCourse } from "./src/index.ts";

const problems = validateCourse("courses/mcp-server");
// [{ severity: "error" | "warning", file: "course.yaml", line?: 3, message: "..." }, ...]
```

`file` is the path inside the course folder, with `/`. Later steps (#8, #12) add their checks next to the ones here and reuse `validateCourse`.

## Quizzes

`validateCourse` checks the `quiz.yaml` of every chapter listed in `course.yaml` (a missing one is reported once, by the layout check; a chapter that is not listed is not checked). The format and its limits are in [`courses/README.md`](../courses/README.md#quizzes). The shape is one JSON Schema, `schemas/quiz.schema.json`, compiled by the same ajv setup (strict mode) as the other two; the rules that a schema cannot say are in `src/quiz.ts`, with the numbers in one place, `QUIZ_LIMITS`:

- exactly 5 questions; 2 or 3 options per question; `correct` is the `id` of exactly one option
- option IDs are unique in a question, option texts too (after trimming, with the same capitals); question IDs are unique in the whole course (the later question fails and the message names the file and line of the first use)
- `lesson` is the ID of a lesson in the same chapter: the `id` in the lesson's front matter when it is valid, otherwise the file name without `.mdx` (`lessonId` in `src/chapter.ts`, which #12 reuses for `ids.json`)
- `explanation` is at most 1000 characters and `snippet.code` at most 2000, counted as Unicode characters after CRLF becomes LF

A message names the question by its `id` (``question `tools-2`: missing required field `explanation` ``), or by its position (`question 3`) when it has no usable `id`; a part of a question is named too (``question `tools-2`, option `a`: ...``, ``question `tools-2`, snippet: ...``). Every problem has the file `chapters/<chapter>/quiz.yaml` and the line of the key or list item when the YAML has one. A problem never quotes question text, option text, an explanation, code, or the value of `correct`: a quiz holds the answer key, so only ids, counts, lines, and file paths are printed.

### Compiling the quizzes

```ts
import { compileQuiz, writeQuizzes } from "./src/index.ts";

// One quiz from its text. It reads no file and never throws for a content error.
const result = compileQuiz(text, { courseId: "mcp-server", chapterId: "03-tools", lessonIds: ["01-intro", "02-crud"] });
// { quiz: { course_id, chapter_id, questions } }  or  { problems: Problem[] }, never both

// Every listed chapter of a course. Returns [] after writing, or the problems and writes nothing.
const problems = writeQuizzes("courses/mcp-server", "build");
```

`compileQuiz` also takes `questionIds`, a `Map` that it fills with the question IDs it has seen, so that a caller checking several chapters finds a repeat in another chapter. Without `lessonIds` (or with none) the `lesson` links are not checked.

`writeQuizzes(courseDir, buildDir)` checks every listed chapter's quiz as `validateCourse` does and, only if no quiz has a problem, writes one file per chapter at `<buildDir>/private/quizzes/<course_id>/<chapter_id>.json` (`course_id` is the course folder name, `chapter_id` the chapter folder name, such as `03-tools`). It first removes `<buildDir>/private/quizzes/<course_id>/`, and only that folder, so a removed chapter leaves no old file, and it writes nothing outside it. On a quiz problem it writes nothing and leaves the build folder as it was. It does not check the rest of the course: run `validateCourse` first. The build command and the real build folder come with #12.

The files hold the answer key and the explanations, so they are private build data for the backend to read: they live under `private/` so that nothing served and no image of the frontend takes them.

A file is `{ "course_id", "chapter_id", "questions": [...] }`. A question has, in this order, `id`, `text`, `snippet` (only when the author wrote one; `language`, `code`), `options` (each `id`, `text`), `correct`, `explanation`, `lesson`. Each object is built by listing its fields, so nothing else reaches the file. The order of the questions and options is the order in the YAML. Values are written as parsed, except that CRLF becomes LF and `text`, option `text`, and `explanation` are trimmed (so a `|` block leaves no trailing newline); `snippet.code` is kept as parsed, so a `|` block ends with one newline. The files are UTF-8 without a byte order mark, with LF line endings, a 2-space indent, a final newline, and non-ASCII text as it is. The same course gives byte-identical files whatever the folder, the build folder, the platform, or the line endings and byte order mark of `quiz.yaml`. The golden output of the valid fixture is in `fixtures/expected/`.

## Layout

- `src/course.ts` - `validateCourse`: the course folder and `course.yaml`
- `src/chapter.ts` - one chapter: `lessons/`, `quiz.yaml`, and the lesson front matter; `lessonId` and `splitFrontMatter` are shared helpers
- `src/quiz.ts` - `compileQuiz`: the quiz rules, the limits, and the data to write; `src/write-quizzes.ts` - `writeQuizzes`
- `src/schema.ts` - ajv checks, with messages that name the field instead of the schema keyword
- `schemas/` - the JSON Schemas for `course.yaml`, the lesson front matter, and `quiz.yaml` (component props schemas live in `frontend/src/content-components/schemas/`, not here)
- `src/folder.ts`, `src/yaml-file.ts`, `src/report.ts`, `src/problem.ts` - reading folders and YAML, collecting and printing problems
- `src/cli.ts` and `src/validate.ts` - the `validate` command and its entry point
- `fixtures/quizzes/valid/<case>.yaml` and `fixtures/quizzes/invalid/<case>.yaml` - single quiz files; a test puts one into a copy of the valid course as `chapters/01-first-steps/quiz.yaml`
- `fixtures/expected/` - the golden output of `writeQuizzes` for the valid course
- `fixtures/valid/` - a valid course; `fixtures/invalid/<case>/` - one course per rule it breaks; `fixtures/warnings/<case>/` - courses that are valid but get a warning. Each folder's name is the course `id`, except `invalid/id-mismatch`.
- `tests/` - the Vitest tests. Cases that depend on line endings or a byte order mark are written to a temporary folder by the test, so git's line-ending settings cannot change them.

Names are looked up in folder listings and compared exactly, never opened by a typed name, so the checks give the same result on Windows, macOS, and Linux.
