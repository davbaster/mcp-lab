# content-build

A Node + TypeScript tool that validates the courses in `courses/` and compiles their restricted MDX to JSON. So far it validates the folder layout, `course.yaml`, the lesson front matter, each chapter's `quiz.yaml`, and each chapter's code steps, and it compiles the quizzes and the code steps to private JSON (and the code to ZIPs). The format is described in [`courses/README.md`](../courses/README.md).

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

## Code steps

`validateCourse` checks the `code/` folder of every chapter that has one: the chapters listed in `course.yaml` and an unlisted chapter that has only `code/` (a chapter in progress, which keeps the warning). A chapter with no `code/` folder is valid and has no output; a `code/` that is not a folder keeps the layout warning and is ignored. The format is in [`courses/README.md`](../courses/README.md#code-steps). The reading and checking is in `src/code-steps.ts`; the numbers are in one place, `CODE_LIMITS`:

- steps are `step-1`, `step-2`, and so on: `step-` and a whole number with no leading zero, in exactly that spelling (the name is looked up in the folder listing, so `Step-1` and `step-01` are rejected on Windows and macOS too). Any other entry of `code/`, and a step that is a file, is an error that names it. A gap, or no `step-1`, is an error on `code/` that names the first missing step. At most `maxSteps` (20) steps in a chapter
- a step has at least one file at any depth (empty folders and `.DS_Store` / `Thumbs.db` do not count, and are neither read nor shipped), and at most `maxFilesPerStep` (100)
- a file is UTF-8 text without a NUL character (an empty file is fine) and at most `maxFileBytes` (262,144 bytes, as read from disk, so before the byte order mark and CRLF are normalized)
- `__pycache__`, `.venv`, `node_modules`, `.pytest_cache` (a file or a folder, anywhere in a step; the build does not look inside), and any `.pyc` file are errors: they must not be committed
- an entry that is not a plain file or folder (a symbolic link, a named pipe) is an error; the build never follows links, so a step cannot pull in a file from outside the course
- a path inside a step must extract on Windows (`src/windows-paths.ts`, a function of path strings only, tested on lists of paths): no `< > : " \ | ? *` or control character in a name, no name ending in a space or a dot, no device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`, with or without an extension, in any case), no two names in one folder that differ only in letter case, and at most `maxPathLength` (100) characters (JavaScript string length) from the step folder down. Each problem names the shortest path that has it, so a bad folder name is reported once

Every problem has `file` set to the folder or file inside the course (`chapters/03-tools/code/step-2/server.py`) and no line number. A problem never quotes file content. A bad step does not stop the other chapters from being checked.

`inspectCourse(courseDir).code` has `problems` (the problems of the code steps of the listed chapters) and `chapters`: for each listed chapter whose steps are all valid, `{ chapter_id, steps: [{ step, files }] }`, where `files` is a `Map` from each file path (with `/`, sorted) to its normalized text. #8 uses it to check the `step` and `file` props of `CodeSteps`.

### Text and diffs

A file's text is normalized once, for the JSON and the ZIP alike (`normalizeText`): `\r\n` becomes `\n` and one leading byte order mark is removed. A lone `\r`, trailing spaces, tabs, and the presence or absence of a final newline are kept. A step written with CRLF and a byte order mark therefore gives the same JSON and the same ZIP as the same step written with LF.

A line is the text between `\n`s. A file with N lines has line numbers 1 to N; a final newline adds no empty last line, and an empty file has 0 lines. The line comparison is the `diff` package (`diffArrays` on the lines, each with its line ending, so adding only a final newline changes the last line). `diffSteps` (`src/step-diff.ts`) takes the steps as text in memory and returns, for each step in number order:

- step 1: every file `added`, with every line in `changed_lines`
- a later step: every file of the step plus every file of the previous step that is gone, sorted by path as plain strings (code-unit order, never the locale's). Status is `added` (not in the previous step), `modified` (in both, text differs), `unchanged` (in both, same text), or `deleted` (only in the previous step; its `content` is `""`). A renamed file is a `deleted` plus an `added`
- `changed_lines`: the numbers of the lines of the new version that are new or changed, ascending, without repeats; `[]` for `unchanged` and `deleted` files, and for a `modified` file whose only change is removed lines
- a file that differs from the previous version by more than `MAX_EDIT_LENGTH` (10,000) added plus removed lines is reported as changed in every line, so one huge rewrite cannot make the build slow

### The ZIP

`buildChapterZip` (`src/chapter-zip.ts`, with `jszip`) zips the final step (the highest number) of a chapter: exactly its files, with the normalized text, under one top-level folder named after the chapter folder (`03-tools/server.py`, `03-tools/src/util.py`), with `/` in the paths, no folder entries, and no other entries. Entries are in the same order as the JSON, each with the time `1980-01-01 00:00:00` (the earliest a ZIP can hold), the mode `0644` (stored as a regular file by the "UNIX" platform), deflate at level 6, and no comment. (JSZip stores an empty file without compression.) The ZIP is written by `pako`, in JavaScript, so its bytes do not depend on the Node version, the platform, or the time zone, and the golden JSON holds the ZIP's hash, so a change that alters the bytes fails a test. The file name is `<chapter_id>-<first 16 hex digits of the SHA-256>.zip`, so a changed chapter gets a new name.

### Writing the step data

```ts
import { writeCodeSteps } from "./src/index.ts";

// Every listed chapter of a course. Returns [] after writing, or the problems and writes nothing.
const problems = await writeCodeSteps("courses/mcp-server", "build");
```

`writeCodeSteps(courseDir, buildDir)` is async because the ZIP writer is. It checks the code steps of every listed chapter as `validateCourse` does. On any error it writes nothing, leaves the build folder as it was, and returns the problems. It does not check the rest of the course: run `validateCourse` first. An empty `buildDir` throws. Everything is built in memory first. Then it removes `<buildDir>/private/code/<course_id>/` (and only that folder, so a chapter that lost its code leaves no old file, and the quizzes next to it are untouched) and writes, for each listed chapter that has steps, `<chapter_id>.json` and `<chapter_id>-<hash>.zip` there, and nothing anywhere else. When no chapter has code, nothing is created. A chapter in progress gets no output. The files are under `private/` because the backend serves steps and ZIPs under the chapter's lesson access rules, so no image of the frontend may hold them.

`<chapter_id>.json` is, with the keys in this order:

```json
{
  "course_id": "mcp-server",
  "chapter_id": "03-tools",
  "zip": { "file": "03-tools-0123456789abcdef.zip", "sha256": "<64 hex digits>", "size": 1234 },
  "steps": [
    { "step": 1, "files": [{ "path": "server.py", "status": "added", "content": "...", "changed_lines": [1, 2] }] }
  ]
}
```

`step` is a number, `path` uses `/`, `zip.file` is the ZIP's file name, `zip.sha256` is the full hash, and `zip.size` is in bytes. Each object is built by listing its fields. The file is UTF-8 without a byte order mark, with LF line endings, a 2-space indent, a final newline, and non-ASCII text as it is. The same course gives byte-identical files whatever the folder, the build folder, the working folder, the time zone, the platform, or the line endings and byte order mark of the source files. The golden output of the valid fixture (`fixtures/expected/private/code/sample-course/`) is compared exactly; the ZIP itself is checked by reading it back.

## Layout

- `src/course.ts` - `validateCourse`: the course folder and `course.yaml`
- `src/chapter.ts` - one chapter: `lessons/`, `quiz.yaml`, and the lesson front matter; `lessonId` and `splitFrontMatter` are shared helpers
- `src/quiz.ts` - `compileQuiz`: the quiz rules, the limits, and the data to write; `src/write-quizzes.ts` - `writeQuizzes`
- `src/code-steps.ts` - the code step checks and `CODE_LIMITS`; `src/windows-paths.ts` - the Windows path rule; `src/text.ts` - normalizing and splitting text
- `src/step-diff.ts` - `diffSteps`; `src/chapter-zip.ts` - `buildChapterZip`; `src/write-code-steps.ts` - `writeCodeSteps`
- `src/schema.ts` - ajv checks, with messages that name the field instead of the schema keyword
- `schemas/` - the JSON Schemas for `course.yaml`, the lesson front matter, and `quiz.yaml` (component props schemas live in `frontend/src/content-components/schemas/`, not here)
- `src/folder.ts`, `src/yaml-file.ts`, `src/report.ts`, `src/problem.ts` - reading folders and YAML, collecting and printing problems
- `src/cli.ts` and `src/validate.ts` - the `validate` command and its entry point
- `fixtures/quizzes/valid/<case>.yaml` and `fixtures/quizzes/invalid/<case>.yaml` - single quiz files; a test puts one into a copy of the valid course as `chapters/01-first-steps/quiz.yaml`
- `fixtures/expected/` - the golden output of `writeQuizzes` and `writeCodeSteps` for the valid course
- `fixtures/valid/` - a valid course; `fixtures/invalid/<case>/` - one course per rule it breaks; `fixtures/warnings/<case>/` - courses that are valid but get a warning. Each folder's name is the course `id`, except `invalid/id-mismatch`.
- `tests/` - the Vitest tests. Cases that depend on line endings or a byte order mark are written to a temporary folder by the test, so git's line-ending settings cannot change them.

Names are looked up in folder listings and compared exactly, never opened by a typed name, so the checks give the same result on Windows, macOS, and Linux.
