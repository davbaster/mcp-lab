# content-build

A Node + TypeScript tool that validates the courses in `courses/` and compiles their restricted MDX to JSON. It validates the folder layout, `course.yaml`, the lesson front matter, each chapter's `quiz.yaml`, each chapter's code steps, and the files in `assets/` with the asset and media references of the lessons, it compiles every lesson to a JSON tree (or rejects it), it compiles the quizzes and the code steps to private JSON (and the code to ZIPs), it writes the allowed assets under content-hashed names, and `build` writes all of it, with a manifest per course, to one build folder that the backend reads (see [Building the courses](#building-the-courses)). It also keeps the list of published IDs and fails when one is removed without a note (see [Stable IDs](#stable-ids)). The format is described in [`courses/README.md`](../courses/README.md).

It needs Node 24 (the version in the root `.nvmrc`). The scripts run `.ts` files with Node's built-in type stripping, so no TypeScript runner is installed, `engines.node` is `>=24`, and the code uses only erasable TypeScript syntax (`erasableSyntaxOnly` in `tsconfig.json`: no enums, namespaces, or constructor parameter properties). Imports of local files end in `.ts`.

## Commands

Run from the repo root with `make install-content-build`, `make lint-content-build`, `make typecheck-content-build`, and `make test-content-build`, or in this folder:

- `npm ci` - install the packages (no browser; see [Diagrams](#diagrams))
- `npm run install:browser` - download the Chromium that draws Mermaid diagrams (`make install-content-build` runs both)
- `npm test` - the tests (Vitest, single run)
- `npm run lint` - ESLint
- `npm run typecheck` - `tsc --noEmit`
- `npm run validate -- <course folder>` - check one course folder, for example `npm run validate -- fixtures/valid/sample-course` (the path may use `/` or `\`)
- `npm run compile -- <lesson.mdx>` - compile one lesson to its JSON tree (see [Lessons](#lessons))
- `npm run build -- <courses folder> <build folder>` - build every course, for example `npm run build -- ../courses ../build` (see [Building the courses](#building-the-courses); `make build-content` runs this)
- `npm run ids:update -- <courses folder>` - write `ids.json` in every course (`make update-content-ids`)
- `npm run ids:check -- <courses folder> [--base <git ref>]` - check `ids.json`, and with `--base` the removed IDs (see [Stable IDs](#stable-ids); `make check-content-ids` and `make check-content-ids-base BASE=origin/main`)

`validate` prints each problem on its own line, on stdout, as `<path>[:<line>[:<column>]]: error: <message>` or `<path>[:<line>[:<column>]]: warning: <message>`, then `N error(s), M warning(s)`. `<path>` is the course path as given plus the file's path inside the course, always with `/`. Only the problems of a lesson body have a column. All problems come in one run, sorted by path and then message. The exit code is 1 if there is an error, 0 otherwise, 2 when no path is given, and 3 when a component schema is not valid (see [Setup errors](#setup-errors)).

## Using it from code

```ts
import { validateCourse } from "./src/index.ts";

const problems = validateCourse("courses/mcp-server");
// [{ severity: "error" | "warning", file: "course.yaml", line?: 3, message: "..." }, ...]
```

`file` is the path inside the course folder, with `/`. A problem of a lesson body also has a `column`. The checks of the build and of the ID list use `validateCourse` and `inspectCourse` (the same check, with what the build needs: the compiled lessons, quizzes, code steps, assets, and the fields of `course.yaml`).

## Lessons

`validateCourse` compiles the body of every lesson of every listed chapter with `compileLesson`, and adds the problems to its list. A lesson whose front matter block cannot be found is not compiled, because the layout check already reports it. The format a lesson may use is in [`courses/README.md`](../courses/README.md#lessons).

```ts
import { compileLesson, serializeTree } from "./src/index.ts";

const result = compileLesson(text, { path: "chapters/01-intro/lessons/01-welcome.mdx" });
if ("problems" in result) {
  // [{ severity: "error", file, line, column, message }, ...] in the order of the lesson
} else {
  const json = serializeTree(result.tree); // what `compile` prints; `build` writes it, after `rewriteAssetUrls`, to the build output
}
```

`compileLesson(source, options)` takes the lesson text and its path (used as `file` in the problems) and returns either `{ tree }` or `{ problems }`, never both and never a thrown lesson error. It reads no file except the component schemas. `options.schemaDir` is the folder of the component schemas; it defaults to `frontend/src/content-components/schemas/`, found from `src/lesson.ts` and not from the working folder.

How it works:

- The text is normalized first: every line ending becomes LF, and one leading byte order mark is removed. A CRLF file with a byte order mark gives the same tree, byte for byte, as the LF file, and the same lines and columns.
- The front matter block is split off with the same `splitFrontMatter` as the layout check, and a missing or unclosed block is rejected with its message (at line 1, column 1). What the front matter holds is not checked again. The front matter lines are left blank, not cut, so a line number is a line of the file.
- The body is parsed to a syntax tree by `remark-parse` and `remark-mdx` (through `unified`) and then read by `src/lesson.ts`. Nothing is evaluated or bundled: the JavaScript in a lesson is parsed to find it and reject it, and never run. A test uses a lesson that would set a global and checks that it stays unset.
- Each node of the output is built by listing its fields, so nothing else from the parser reaches the output. The finished tree is checked against `schemas/lesson-tree.schema.json` before it is returned.
- Lines and columns are the parser's: they start at 1, and a column counts UTF-16 code units, so a tab is one column and an emoji is two. A parse error (an unclosed tag, a closing tag that does not match, a JavaScript syntax error, `<!-- -->`, and so on) stops that lesson at the first error, with the parser's message and position. A lesson without a parse error reports all its problems, in the order of the lesson. The problems of different lessons are independent.

### The tree

The tree is data only: no functions, no code strings, no `position`, and no fields other than the ones below. `schemas/lesson-tree.schema.json` (draft-07) is the contract that the frontend renders from (#19).

- The root is `{ "type": "root", "children": [...] }`. A lesson with front matter and no body is `{"type":"root","children":[]}`.
- Markdown nodes are named like mdast and have only these fields: `heading` (`depth` 1 to 6, `children`), `paragraph`, `blockquote`, `list` (`ordered`, `start` only when ordered, `children`), `listItem`, `code` (`lang` when given, `value`), `thematicBreak`, `text` (`value`), `emphasis`, `strong`, `inlineCode` (`value`), `break`, `link` (`url`, `title` when given, `children`), and `image` (`url`, `alt`, `title` when given).
- A component is `{ "type": "component", "name": "Callout", "props": { ... }, "children": [...] }`. `children` is always there, and is `[]` for a component that takes none. `props` holds each prop the author wrote, as a string or `true` for a bare attribute (`<X flag />`), with the keys in code-unit sorted order. `Tab` is a component node inside the `Tabs` node.
- Components are block-level only (on their own lines, or inside a list item or a block quote). One in a paragraph is rejected.
- The golden trees are in `fixtures/lessons/valid/<case>.json` beside the lesson, and a test compares them byte for byte.

### Rejected content

Each of these is an error with the file, the line, and the column. A test for each case is in `tests/lesson-rejections.test.ts`, with a lesson in `fixtures/lessons/invalid/`.

- JavaScript: an expression in text or in a prop, a spread `{...props}`, a comment `{/* note */}`, and `import` or `export`. For a prop or a spread, the column is the start of the attribute.
- HTML elements and `<script>`, fragments (`<>`), and names with `:` or `.`.
- An attribute whose name starts with `on`, in any letter case, on a component or an element.
- A component name that is not a file in the schema folder (compared exactly, from the folder listing, so `<CALLOUT>` is unknown even where the file system ignores case); a prop that the schema does not list, a prop written twice, a prop of the wrong type, outside its `enum` or `pattern`, empty, or a required one that is missing; a `oneOf` that is not met; children that the component does not take (see `x-children`). `__proto__` or `constructor` as a name is simply unknown.
- A URL with a scheme other than `http`, `https`, or `mailto`, in a link, an image, or a URL prop. The check reads a URL as a browser does: it ignores the case, tabs and line breaks inside the scheme, and spaces or control characters in front, and it rejects `//` at the start. Relative URLs and `#`, `?`, `/` URLs are fine. Whether a URL points to an allowed origin or to a file that exists is #9.
- Nesting more than 100 levels deep (`MAX_DEPTH` in `src/lesson.ts`): a lesson nested far deeper than that overflows the parser's stack, and is reported the same way.
- Reference-style links and images and their definitions, and a code fence with text after the language. Tables, strikethrough, task lists, and footnotes are not parsed and stay plain text.

Text that only looks like code is kept as it is: a code fence or inline code that holds `import x`, `<script>`, `{1 + 1}`, or `onClick`, an escaped brace `\{`, and the text `a < b`.

### Component schemas

`frontend/src/content-components/schemas/<Name>.schema.json` holds one draft-07 JSON Schema for the props object of each component: `type: object`, `required`, `properties`, and `additionalProperties: false`. Authors can only write a string or a bare attribute, so every property is `type: string` (with `enum`, `pattern`, or `minLength: 1` where needed) or `type: boolean`. The compiler lists the folder and reads each `<Name>.schema.json` in ajv's strict mode, so a keyword that ajv does not know is an error. Three annotations are registered, and their values are checked as the schema compiles:

- `"x-kind": "url"` on a string property: the prop is a URL, and the compiler checks its scheme with the same function as for Markdown links (`src/url.ts`).
- `"x-children"` (required in every schema): what may be between the tags. `"none"`, or `{ "markdown": true, "components": "all" }` (Markdown and every component), or `{ "markdown": false, "components": ["Tab"], "min": 2 }` (only the listed components, at least `min` of them).
- `"x-nested"`: components that exist only inside this one, each a props schema of its own, with its own `x-children`. `Tab` is declared inside `Tabs.schema.json` and has no file, so each schema file still maps to one frontend component. A `Tab` outside `Tabs` is an unknown component.

A `oneOf` over `required` is how a schema says "exactly one of these props" (`Diagram`: `src` or `source`). strictRequired is off for these schemas, and the loader checks that every name in `required` is a property.

To add a component, add `<Name>.schema.json` (the name starts with a capital letter) and the entry in the component registry of the frontend (#19); both are an app change that is reviewed. Nothing in `frontend/` imports from `content-build/`, and the other way round.

The rule tests use a small copy of the schemas in `fixtures/components/`, so they do not change when a real schema does; one test checks the real folder.

### Setup errors

A schema file that is not valid JSON, or not a valid component schema, stops the compile with a message that names the file. It is a problem of the build and not of a lesson, so it is thrown as a `SetupError` and never returned in the problems. `validate` and `compile` print it on stderr as `build setup error: <message>` and exit with 3.

### The `compile` command

`npm run compile -- <lesson.mdx>` (the path may use `/` or `\`) prints the tree on stdout, as UTF-8 with LF line endings, a 2-space indent, and a final newline, and exits 0. For a rejected lesson it prints nothing on stdout, each problem on stderr as `<path>:<line>:<column>: error: <message>` (the path with `/`) followed by `N error(s), M warning(s)`, and exits 1. A missing or unreadable file, or one that is not UTF-8 text, is a rejection too. No path, or more than one, prints the usage on stderr and exits 2.

**Windows PowerShell 5.1:** `npm run compile -- lesson.mdx > tree.json` writes `tree.json` as UTF-16 with a byte order mark, because PowerShell 5.1 re-encodes what `>` redirects. A tree saved that way is not valid input for anything else (not for `JSON.parse`, the build, or the frontend). Use PowerShell 7, where `>` writes UTF-8, or `cmd /c "npm run compile -- lesson.mdx > tree.json"`, which writes the bytes as they are. The build output is written by Node, not by a redirect, and is always UTF-8 with LF.

## Quizzes

`validateCourse` checks the `quiz.yaml` of every chapter listed in `course.yaml` (a missing one is reported once, by the layout check; a chapter that is not listed is not checked). The format and its limits are in [`courses/README.md`](../courses/README.md#quizzes). The shape is one JSON Schema, `schemas/quiz.schema.json`, compiled by the same ajv setup (strict mode) as the other two; the rules that a schema cannot say are in `src/quiz.ts`, with the numbers in one place, `QUIZ_LIMITS`:

- exactly 5 questions; 2 or 3 options per question; `correct` is the `id` of exactly one option
- option IDs are unique in a question, option texts too (after trimming, with the same capitals); question IDs are unique in the whole course (the later question fails and the message names the file and line of the first use)
- `lesson` is the ID of a lesson in the same chapter: the `id` in the lesson's front matter when it is valid, otherwise the file name without `.mdx` (`lessonId` in `src/chapter.ts`, which `ids.json` reuses)
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

`writeQuizzes(courseDir, buildDir)` checks every listed chapter's quiz as `validateCourse` does and, only if no quiz has a problem, writes one file per chapter at `<buildDir>/private/quizzes/<course_id>/<chapter_id>.json` (`course_id` is the course folder name, `chapter_id` the chapter folder name, such as `03-tools`). It first removes `<buildDir>/private/quizzes/<course_id>/`, and only that folder, so a removed chapter leaves no old file, and it writes nothing outside it. On a quiz problem it writes nothing and leaves the build folder as it was. It does not check the rest of the course: run `validateCourse` first. `build` calls it for every course (see [Building the courses](#building-the-courses)).

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

`inspectCourse(courseDir).code` has `problems` (the problems of the code steps of the listed chapters) and `chapters`: for each listed chapter whose steps are all valid, `{ chapter_id, steps: [{ step, files }] }`, where `files` is a `Map` from each file path (with `/`, sorted) to its normalized text. A later check can use it to look at the `step` and `file` props of `CodeSteps`, which the lesson compiler checks only for their shape.

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

## Assets

The build checks every file in a course's `assets/` folder, once per course whether or not a lesson uses it, and every asset and media reference in the lessons. Anything that could run code, load something from an unapproved origin, or point at a missing file fails the build with a message that names the file (and the line and column, for a lesson). `writeAssets` then writes the allowed files to a public build folder under content-hashed names.

### Files in `assets/`

- Only `.png`, `.jpg`, `.jpeg`, `.webp`, `.svg`, `.glb`, `.gltf`, and `.vtt` are allowed, in any letter case; the hashed name always has the extension in lowercase. Anything else is an error that lists the types. For a video (`.mp4`, `.webm`, `.mov`, `.m4v`, `.ogv`) the message adds that videos go on the media CDN and are used with `Video`. There is no exemption for a `README.md` in `assets/`. Subfolders are allowed. `.DS_Store` and `Thumbs.db` are ignored at any depth.
- The first bytes must match the extension: `.png` the PNG signature, `.jpg` and `.jpeg` `FF D8 FF`, `.webp` `RIFF....WEBP`, `.glb` `glTF`. A file of 0 bytes is an error.
- Size limits come from `media-config.json` (below), in bytes on disk: images (`.png`, `.jpg`, `.jpeg`, `.webp`, `.svg`) 5 MiB, models (`.glb`, `.gltf`) 25 MiB, captions (`.vtt`) 1 MiB. A file of exactly the limit passes; one byte more fails. "MB" in the issues means MiB (1,048,576 bytes).
- A symbolic link, or anything that is not a plain file or folder, is an error; the build never follows links. Names must extract on Windows (`windowsPathProblems`, with a path limit of 100 characters from `assets/`), and a file or folder name may use only letters, digits, `.`, `_`, and `-` and may not start with `.`, so a path never needs URL-encoding. A problem names the shortest path that has it.
- A `.vtt` must be UTF-8 text without a NUL character that starts with `WEBVTT`. A `.gltf` must be UTF-8 JSON, and every `uri` in its `buffers` and `images` must start with `data:`: a `.gltf` that points to an outside file (such as a `.bin`) must embed it or become a `.glb`.
- Text files (`.svg`, `.vtt`, `.gltf`) are normalized once before hashing and copying: CRLF and a lone CR become LF, and one leading byte order mark is removed. Binary files are used byte for byte.
- A file that no lesson of a listed chapter uses is a warning on `assets/<path>`. Using a file as a `Model3D` or `Video` `poster`, or as `captions`, counts as using it. The warning is given only when every lesson compiled without a problem, because a broken lesson's references are not known.

### SVG rules

Every `.svg` in `assets/` is scanned as text (the normalized UTF-8 text, case-insensitive), with no XML parser. The scan looks at the whole text, comments and CDATA included, so it may reject a harmless file; that is the point. Each rule is reported once per file, with the line of its first match.

- Not UTF-8 (for example UTF-16), a NUL character, or an XML declaration with an `encoding` other than `utf-8`.
- No `<svg` start tag.
- An element named `script`, `foreignObject`, `iframe`, `embed`, `object`, `animate`, or `set`, with or without a namespace prefix (`<svg:script>`).
- An attribute whose name starts with `on` (`onload`, `OnClick`), found after whitespace, a quote, or `/` (so `<svg/onload=...>` is caught).
- Any `href` or `xlink:href` attribute (with or without a prefix, any letter case, spaces around `=`) whose value is not quoted or does not start with `#`. So `http:`, `javascript:`, `data:`, entity-encoded, and relative-file values are rejected; `href="#a"` for `<use>` is fine.
- A `<!DOCTYPE` with an internal subset (a `[` after `<!DOCTYPE`, whatever the spacing or letter case; quoted literals are skipped). A subset can declare entities and, with `<!ATTLIST>`, give an element a default `onload` or `href` that no attribute rule would see. A plain `<!DOCTYPE svg PUBLIC ...>` without `[` is fine.
- `<!ENTITY` anywhere, or a `<?xml-stylesheet` instruction.
- `@import` anywhere, or a `url(` whose argument (after optional spaces and a quote) does not start with `#`.

The scan is plain text. It does not decode CSS escapes (`\75rl(`) or character references, and it does not understand CSS comments, so a tricky spelling can slip past it. These checks are one layer, and the others cover that. `Image` and `Diagram` show an SVG as an `<img>` (#19), which does not run scripts, and the asset route sends `script-src 'none'` and `nosniff` (#58).

### The media config

`media-config.json` (next to `package.json`, found from the source file and not from the working folder) is the only list of media origins and size limits; `schemas/media-config.schema.json` is its draft-07 schema, and `loadMediaConfig()` in `src/media-config.ts` reads and checks it. Changing it is a reviewed change. No file in `src/` contains an origin or host from it; messages build their suggestions from the config.

```json
{
  "mediaOrigins": ["https://media.mcp-lab.example"],
  "embeds": [
    {
      "origin": "https://www.youtube-nocookie.com",
      "pathPrefix": "/embed/",
      "idPattern": "^[A-Za-z0-9_-]+$",
      "watchHosts": ["www.youtube.com", "youtube.com", "m.youtube.com", "youtu.be"]
    }
  ],
  "assetLimits": { "imageBytes": 5242880, "modelBytes": 26214400, "captionBytes": 1048576 }
}
```

- `mediaOrigins`: `https` origins of files on the media CDN. The placeholder is replaced in #34.
- `embeds`: video sites that may be embedded. `origin` is the player's origin, `pathPrefix` the path before the ID (a slash at both ends), `idPattern` a regular expression for the ID (from `^` to `$`), and `watchHosts` the hosts of the site's watch pages, which are rejected with a hint to use the embed form. The file also lists Vimeo.
- `assetLimits`: the size limits in bytes: `imageBytes` for images, `modelBytes` for models, and `captionBytes` for captions.
- An origin must be exactly what `new URL(origin).origin` returns: `https` only, a lowercase host of letters, digits, dots, and hyphens, no path or trailing `/`, no wildcard, no credentials, no default port. Origins are not repeated, within a list or between `mediaOrigins` and the `embeds` origins. A file that does not match its schema, or has a bad origin, throws a `SetupError` that names the file and the key, so `validate` prints `build setup error: ...` and exits 3.

**For #20:** the Content-Security-Policy is generated from this file, which #20 reads and does not copy: `mediaOrigins` give `img-src` and `media-src`, and the `origin` of each `embeds` entry gives `frame-src`.

### References in lessons

`compileLesson` returns the references it found next to the tree (`{ tree, references }`; the tree and its golden files are unchanged). Each is `{ component, prop, value, line, column }`, at the prop or the Markdown image (`component` is `Markdown` and `prop` is `image` for `![alt](path)`). `src/assets.ts` holds the table of which props refer to a file or a media URL: `Image.src`, `Diagram.src`, `Model3D.src`, `Model3D.poster`, `Video.captions`, `Video.poster`, `Video.src`, and the URL of a Markdown image. A Markdown link and `CodeSteps` props are not references, and a `Diagram` with `source` (Mermaid) is not a reference either: it has its own checks (see [Diagrams](#diagrams)).

A value without a scheme (it does not match `^[A-Za-z][A-Za-z0-9+.-]*:`) is an *asset path*, relative to `assets/` and written without the `assets/` prefix (`images/pic.png`). It is looked up, exactly and case-sensitively, in the folder listing of `assets/`; a typed path is never opened. These are errors, each with its own message: an empty path, a path that starts with `/` or `\`, a `..` or `.` part, a backslash, an empty part (`a//b.png`), a `%`, `?`, or `#`, a name the name rule forbids, a path to a folder, and a missing file (a file that differs only in letter case is named in the message). The file type must fit the use: an image (`.png`, `.jpg`, `.jpeg`, `.webp`, `.svg`) for `Image.src`, a Markdown image, `Model3D.poster`, and `Video.poster`; `.glb` or `.gltf` for `Model3D.src`; `.svg` for `Diagram.src`; `.vtt` for `Video.captions`.

`Image.src`, `Diagram.src`, `Model3D.src`, `Model3D.poster`, and a Markdown image must be files in `assets/`: a URL (`http`, `https`, `mailto`) is an error, because the Content-Security-Policy would block it anyway.

`Video.src` must be an absolute `https` URL. It is parsed with `new URL`, and the decision uses the parsed `origin` and `pathname`, never string prefixes. The raw value may not have spaces, control characters, a backslash, or credentials (`user@`). A relative value (even `clip.mp4`) is an error: videos are not served from `assets/`. A URL on a `mediaOrigins` origin is a direct file (letter case in the scheme and host does not matter, and the default port is the same origin). A URL on an `embeds` origin must be `<origin><pathPrefix><id>` with an ID that matches `idPattern`; a query such as `?start=30` is fine. A URL on a `watchHosts` host is an error that suggests the embed form. Any other origin is an error that says it is not in `media-config.json`. `Video.captions` and `Video.poster` are an asset path or a URL on a `mediaOrigins` origin (not an embed origin) whose path ends in `.vtt`, or in an image extension for a poster.

### Writing the assets

```ts
import { writeAssets } from "./src/index.ts";

// Returns [] after writing, or the problems and writes nothing.
const problems = writeAssets("courses/mcp-server", "build");
```

`writeAssets(courseDir, buildDir)` is synchronous, like `writeQuizzes`. It checks the files in `assets/` as above, but not the lessons: run `validateCourse` first. On any error it writes nothing, leaves the build folder as it was, and returns the problems. An empty `buildDir` throws, and a course folder name that is not `^[a-z0-9-]+$` is an error. It removes and rewrites only `<buildDir>/public/assets/<course_id>/` and `<buildDir>/assets-map/<course_id>.json`, and never reads, writes, or removes anything under `<buildDir>/private/`. With no files in `assets/` it writes no asset files, the map has `"files": {}`, and files of an earlier build are removed. Two courses in one build folder do not touch each other.

Each file is written flat, as `<stem>-<first 16 hex digits of the SHA-256>.<ext>`: `stem` is the file name without its extension (folders dropped), the hash is of the bytes written (after the text normalization), and `ext` is lowercase. `images/pic.png` becomes `pic-0123456789abcdef.png`. Two paths with identical bytes and the same stem give one file, a file that changes gets a new name, and a file that moves between folders keeps its name. A file in a folder named `private/` is written flat under `public/assets/<course_id>/` like any other; two files whose output names differ only in letter case are an error. Nothing outside `public/assets/<course_id>/` and the map holds an asset.

The map `<buildDir>/assets-map/<course_id>.json` is outside `public/`, so it is never served. It is, with the keys in code-unit order:

```json
{
  "course_id": "mcp-server",
  "files": {
    "images/pic.png": { "file": "pic-0123456789abcdef.png", "sha256": "<64 hex digits>", "size": 1234 }
  }
}
```

`file` is the hashed name, `sha256` the full hash, and `size` the bytes of the file written. The file is UTF-8 without a byte order mark, with LF line endings, a 2-space indent, and a final newline. The output is byte-identical whatever the course folder's location, the build folder, the working folder, the platform, and the line endings or byte order mark of the text files. `inspectCourse(...).assets` gives the checked files (path, hashed name, sha256, size, and the bytes) for the writer and for `build`.

### Pointing a lesson at the hashed files

`compileLesson` keeps the paths as the author wrote them. The pure function `rewriteAssetUrls(tree, courseId, assetMap)` returns a new tree (the input is not changed) in which every asset reference is `/api/courses/<course_id>/assets/<hashed file name>`, the URL that #58 serves. `assetMap` is the `files` object of the map. It reads the same table of props as the checks. Values that are URLs (an allowlisted `Video.poster` or `captions`) and `Video.src` are not changed, and a reference that is not in the map throws an internal error, because the checks should have caught it. `writeAssets` does not write lesson trees: `build` (#12) calls `compileLesson` and then `rewriteAssetUrls`, and writes `private/lessons/`.

## Diagrams

A `<Diagram alt="..." source="..." />` holds Mermaid text. `npm run build` draws it to an SVG file in a Chromium that the build starts, writes the file with the other assets, and points the lesson at it, so a lesson ships no diagram code and the learner's browser never loads Mermaid (#55). `validate`, `compile`, and `ids:*` never start a browser. The authoring rules are in [`courses/README.md`](../courses/README.md#diagrams); this section is for people who work on the tool.

### What the author may write

- **The type** is the first word of the first line that is not blank and not a `%%` comment. Drawn: `flowchart`, `graph`, `sequenceDiagram`, `classDiagram`, `stateDiagram`, `stateDiagram-v2`, `erDiagram`, and `pie`. Any other type is an error that names it and lists these. Left out on purpose: `gantt` draws a "today" line, so its output would change with the date; `mindmap` needs indentation, and MDX removes the spaces at the start of every line of a prop; `architecture-beta` loads icon packs; `zenuml` is a plugin.
- **Errors before any drawing** (`src/diagram-source.ts`; `validate` reports them without Chromium, at the line of the source line: the prop's line plus the line in the source minus 1, and the column of the prop for the first line and 1 for later lines): a line with `%%{` (an init directive can switch `htmlLabels` back on), a first non-blank line of `---` (front matter can set the configuration), a statement that starts with `click` and a space (it makes a link), a NUL or other control character except tab and line break, and a source of more than 5000 characters (Unicode characters, after CRLF becomes LF) or 200 lines. Exactly 5000 characters and 200 lines pass.
- `compileLesson` returns the uses next to `tree`, `references`, and `codeSteps`: `diagrams`, each `{ source, alt, line, column, tagLine, tagColumn }` (the prop's position and the tag's). The tree still holds `source` as written, so the golden trees and `npm run compile` do not change.
- **The `alt` text is the accessible name.** The node keeps `alt`, and the SVG gets `<title id="diagram-title">` with the `alt` text (escaped, as the first child), `role="img"`, and `aria-labelledby="diagram-title"`. Mermaid's own `<title>` (from `accTitle:`) is replaced; a `<desc>` from `accDescr:` stays. This is done after the cache, so changing only `alt` does not draw again.

### What the build writes

1. `checkCourses` checks every course, including the source rules above. Then `renderDiagrams` (`src/diagrams.ts`) looks up each distinct source in the cache. If some are not there it starts one Chromium (`src/mermaid-render.ts`), draws those, and closes it. A course with no `source`, and a build whose diagrams are all cached, never start it, so they build with no browser installed.
2. Each drawing goes through `finishSvg` (a numeric `width` and `height` equal to the `viewBox`, so the SVG shows at its natural size in an `<img>` and shrinks with CSS) and then `svgProblems`, the same SVG rules as the files in `assets/`, with no new exception. The SVG is **checked and never repaired**: a rule that fails is an error at the `<Diagram>` tag (`the diagram that Mermaid drew breaks an SVG rule, so it is not written (the problem is in the rendered diagram, not in the lesson text): ...`), and nothing is written. A size over `assetLimits.imageBytes` (5 MiB, `media-config.json`) is an error that names the size and the limit.
3. Every problem of every lesson comes in one run, in lesson order and then line order (a problem found before drawing in a later lesson does not come before one found by drawing in an earlier lesson), with the other problems, and nothing is written when there is one (the all-or-nothing rule). A Mermaid syntax error is `<lesson path>:<line>:<column>: error: Mermaid could not parse this diagram: <Mermaid's message>`. The message is Mermaid's own text up to the stack trace, with no stack frame, no absolute path (`<path>`), and no URL (`<url>`). Mermaid counts lines after it drops the leading blank space and every comment line (`%% ...`); `sourceLineOfMermaidLine` counts them back, so the error is at the lesson line of the source line that Mermaid names. If Mermaid names no line, it is the line of the prop. A render that takes more than 30 seconds, and a browser that crashes, are errors at the tag that say which one it was; the browser is then thrown away and the next diagram gets a new one.
4. `writeAssets` writes each SVG as `<build>/public/assets/<course_id>/diagram-<first 16 hex digits of the SHA-256 of the SVG bytes>.svg` (the same folder, hashed-name rule, and map file as the other assets; the Mermaid step writes nothing to `public/` itself, because `writeAssets` replaces that folder). The name matches the pattern the backend checks at startup. `assets-map/<course_id>.json` has an entry with `file`, `sha256`, and `size` under the key `mermaid:<first 16 hex digits of the SHA-256 of the SVG>.svg`: the `:` is a character the asset name rule forbids, so the key cannot be the path of a real file. Two diagrams with the same bytes (also in different lessons) are one file; different bytes are two files; a diagram whose source did not change keeps its name.
5. In the lesson file under `private/lessons/`, the `Diagram` node is `{ "name": "Diagram", "props": { "alt": "<as written>", "src": "/api/courses/<course_id>/assets/<hashed name>" } }`: `source` is gone and `src` takes its place. The Mermaid text is in no file of the build (a test puts a comment line `%% MERMAID-SOURCE-SENTINEL` in a source, which Mermaid drops, and looks for it in every file). The manifest keeps `schema_version` 2, because no field of the manifest or of the tree changes.

### The settings

`mermaid-config.json` is the only place the render settings live (it is LF in `.gitattributes`, and its bytes in the cache key are its text with LF line endings, so a CRLF checkout gives the same key). `schemas/mermaid-config.schema.json` fixes the keys that keep the output safe and the same everywhere with `const`, so a change to one of them is a setup error (`build setup error: mermaid-config.json: ...`, exit 3), not a quiet change; the colors and the contrast are checked by `tests/mermaid-config.test.ts` against the tables of `_docs/design-system.md`. It is only read when a diagram needs drawing.

| Setting | Why |
|---|---|
| `look: "classic"`, `handDrawnSeed: 1` | A class diagram changed from run to run without them. |
| `theme: "base"` and `themeVariables` | The design system's single light theme (no dark mode in v1). Every `#rrggbb` is one of its color tokens, and the text color on each fill is a pair it lists with a contrast of at least 4.5:1. The background is transparent. |
| `fontFamily` and `themeVariables.fontFamily` | `"Recursive Variable", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`. The first font is the one that mermaid-cli bundles and loads, so the layout does not depend on the fonts of the machine; the rest is the design system's text stack. The top-level key matters: a sequence diagram measures its text with it and with nothing else, and without it that diagram was 12 px taller on a machine with other fonts (the one-font fontconfig test found it). An SVG shown as an `<img>` cannot load a font (the asset route blocks fonts from `data:` and there is no `@font-face`), so a learner sees the diagram in the first font of the design system's stack that their machine has, in boxes that were measured with the wider Recursive, which is why text fits. |
| `htmlLabels: false` (top level and in `flowchart`, `sequence`, `class`, `state`, `er`) | Labels are SVG text and no `foreignObject` is written. A `<br/>` in a label is a line break; other HTML is shown as text or dropped. |
| `securityLevel: "strict"` | Mermaid encodes the HTML in labels and turns click handlers off. |
| `useMaxWidth: false` (every supported type) | The SVG gets a width and height in pixels instead of `100%`. |
| `maxTextSize: 5000`, `maxEdges: 100` | The same limit as the source check, and a cap on a drawing that would take a long time. |

The render call (`src/mermaid-render.ts`) also fixes the SVG id (`diagram`), turns font embedding off (the SVG rules and the asset route's Content-Security-Policy refuse `data:` fonts), sets a transparent background, and sets a 1280 by 800 page with a device scale factor of 1.

**A known limit.** The layout still depends on the machine's fonts in some setups. Mermaid measures every text twice, in the configured font and in the machine's generic `sans-serif`, and uses the second measure only when it is both wider and taller than the first; that is the likely cause, but it was not confirmed for every case below. What was measured on Linux, with a fontconfig that holds one font and compared with the goldens (31 single-font setups; the same fixture, all eight types): DejaVu Sans, Liberation Sans, and the other regular sans, serif, and monospace faces from DejaVu, Liberation, and GNU FreeFont gave the same bytes. **Inter Regular and Inter Display Regular as the only font changed the `erDiagram`**, and most other Inter faces (Black, Bold Italic, ExtraLight, Light, and so on), Loma, and JetBrains Mono changed it too (the Inter Black and JetBrains Mono ones also changed the `sequenceDiagram`). A machine with all its usual fonts, Inter among them, gave the goldens. So a machine whose only or main fonts are Inter or JetBrains Mono may produce other bytes for ER and sequence diagrams. If the golden tests fail on a machine and the difference is a few pixels of width or height, run `fc-match sans-serif` and `fc-list` first. The fontconfig test uses DejaVu Sans (or the first of Liberation Sans, Noto Sans, Arimo, FreeSans that it finds).

### The browser

- `npm run install:browser` (it is also the second line of `make install-content-build`) runs `puppeteer browsers install chrome-headless-shell` through `src/browser-install.ts`, which downloads only **chrome-headless-shell**, not full Chrome, at the build that puppeteer 25.16.0 pins (156.0.8078.47), into puppeteer's cache: `~/.cache/puppeteer` on Linux and macOS, `%USERPROFILE%\.cache\puppeteer` on Windows; `PUPPETEER_CACHE_DIR` changes it. It is about 120 MiB to download and 274 MB on disk on Linux, and took 3.4 s on the machine where this was written. `npm ci` downloads no browser (`.puppeteerrc.cjs` and the `puppeteer` key of `package.json` both say `skipDownload: true`; the backend image copies only `package.json` and the lock file before it runs `npm ci`, so the key in `package.json` is the one that works there. Without it that `npm ci` downloaded 676 MB).
- The packages: `@mermaid-js/mermaid-cli` 12.0.0 (it brings `mermaid` 12.2.0) and `puppeteer` 25.16.0, both pinned to an exact version. `node_modules` is about 560 MB after `npm ci` (Mermaid itself 129 MB), and `npm ci` takes about 10 s with a warm npm cache. The lock file lists the Windows packages of the one native optional dependency (`@napi-rs/canvas`). Nothing in `frontend/` or `backend/` depends on `mermaid` or `puppeteer`; a test reads their package and lock files.
- A browser that is not installed, or not the build the code launches (`PUPPETEER_EXECUTABLE_PATH` set to another one), is a setup error and not a stack trace: `build setup error: Chromium (chrome-headless-shell 156.0.8078.47) is not installed: it is not in <folder>; run make install-content-build ...`, exit 3. The same bytes need the same browser.
- **Flags.** The browser runs with `headless: "shell"`, `--host-resolver-rules=MAP * ~NOTFOUND` (no host name resolves, so there is no network; a test has a diagram ask for an image from a local server and sees zero requests), `--font-render-hinting=none`, a temporary profile that is removed at the end (after the browser process has exited; if the system still refuses, as Windows can for a moment, it tries 20 times 250 ms apart, and then only prints a warning), and never `--disable-web-security`. Its sandbox stays on, except that `--no-sandbox` is added when the build runs as root (Docker, CI containers) or when `MERMAID_NO_SANDBOX=1` is set (Ubuntu 24.04 can block the sandbox for a normal user through AppArmor; the `content-build` job of `ci.yml` sets `MERMAID_NO_SANDBOX: 1` for that reason, on the self-hosted Ubuntu 24.04 runner). That is acceptable because the page holds only Mermaid and lesson text from this repo, offline.
- **Unzip.** `npm run install:browser` unpacks the browser with the system `unzip` command on Linux and macOS (`tar.exe` or PowerShell on Windows). Without it the install fails with `no zip archiver is available`, and the command then says to install `unzip` on the machine (on Ubuntu, `sudo apt-get install unzip`). The failed install leaves a half-installed folder, which puppeteer refuses to install over (`The browser folder ... exists but the executable ... is missing`); `npm run install:browser` (`src/browser-install.ts`) removes that one folder, `<cache>/chrome-headless-shell/<platform>-<build>`, when it exists without its executable, and then installs again. It leaves a complete install, other builds, and everything else in the cache alone, and it uses `PUPPETEER_CACHE_DIR` when that is set.
- **Linux libraries.** The browser needs the system libraries in its `deb.deps` file (`~/.cache/puppeteer/chrome-headless-shell/linux-<build>/chrome-headless-shell-linux64/deb.deps`): `libasound2`, `libatk-bridge2.0-0`, `libatk1.0-0`, `libatspi2.0-0`, `libcairo2`, `libcups2`, `libdbus-1-3`, `libexpat1`, `libgbm1`, `libglib2.0-0`, `libnspr4`, `libnss3`, `libpango-1.0-0`, `libudev1`, `libx11-6`, `libxcb1`, `libxcomposite1`, `libxdamage1`, `libxext6`, `libxfixes3`, `libxkbcommon0`, `libxrandr2`, and `fonts-liberation` (on Ubuntu 24.04 some have a `t64` suffix). To see what is missing: `ldd ~/.cache/puppeteer/chrome-headless-shell/linux-*/chrome-headless-shell-linux64/chrome-headless-shell | grep "not found"`. At least one font must be installed.

### The cache

`content-build/.cache/mermaid/` (git-ignored; `MERMAID_CACHE_DIR` overrides it, relative to the working folder) holds one `<key>.svg` per drawn source, outside the build folder, and `build` never deletes it. The key is the SHA-256 of the source (CRLF as LF), the bytes of `mermaid-config.json`, the installed versions of `mermaid` and `@mermaid-js/mermaid-cli`, the Chromium build, and `POSTPROCESS_VERSION` in `src/diagram-svg.ts` (raise it when you change `finishSvg`, the options of the render call, or the browser flags), each part with its name and length. A file name is only ever built from the 64 hex digits. An entry that is empty, is not UTF-8, starts with a byte order mark, fails `svgProblems`, or is not what `finishSvg` writes is ignored and drawn again. The cache keeps the SVG before the accessible name, which is added after it. A build with a warm cache is byte-identical to one with an empty cache. In CI the folder is not kept between jobs, so every job draws again.

### Same input, same bytes

Drawing the same source twice in one browser, in a different order, and in a new browser gives the same bytes, and so does building the fixture into two folders from two working folders. A test with a fontconfig that holds one regular font (Linux only) gives the same bytes as the default fonts. Nothing in the output has an absolute path, a date, or a random id. The SVG id is fixed, `handDrawnSeed` is fixed, and `gantt` (which draws today's date) is not supported.

### Safe SVG: one layer

The checks above are one layer. `Image` and `Diagram` show an SVG as an `<img>` (#19), which does not run scripts, and the asset route sends `Content-Security-Policy: script-src 'none'; default-src 'none'; style-src 'unsafe-inline'; sandbox` and `nosniff` (#58). The CSP blocks fonts and images from `data:`, which is why none are embedded. A test also asserts that every golden has no `data:`, `@font-face`, `@import`, `foreignObject`, `<script`, `href` that is not `#...`, or attribute that starts with `on`.

### Tests

- **Tier 1** (no Chromium; they pass a fake renderer, or a fake launcher, to the build): `diagram-source`, `diagram-svg`, `mermaid-config`, `mermaid-cache`, `mermaid-render` (the launch flags, the timeout, the crash, the profile), `mermaid-build` (the output, the map, the errors, the cache, the all-or-nothing rule, the size limit, the missing browser), `mermaid-dependencies`, and the golden checks of `mermaid-golden`.
- **Tier 2** (the real Chromium; they fail with the setup error if it is not installed): `mermaid-real` (the same bytes in one browser, in the reverse order, and in a new browser, for each type, equal to `fixtures/expected-mermaid/renderer/<type>.svg`; the fontconfig test, which runs on Linux only because fontconfig is a Linux library; HTML in a label; a sequence diagram `link`; a node image from a local server; `accTitle` and `accDescr`; Mermaid's line numbers; the timeout and the crash) and the last two tests of `mermaid-golden` (the real build equals `fixtures/expected-mermaid/build/` byte for byte, from two working folders).
- Both tiers run in `npm test`. The fixture is `fixtures/mermaid/` (a courses folder with the course `mermaid-course`; `fixtures/valid` has no `Diagram` source, so `make check-images` is unchanged).

### Upgrading Mermaid or Chromium

The goldens are exact bytes, so an upgrade changes them on purpose:

1. Change the version in `package.json` (a new dependency version needs the owner's approval, see `AGENTS.md`), run `npm install` in this folder, and commit `package-lock.json` with it. A new puppeteer pins another Chromium: run `npm run install:browser`.
2. Run the tests; the golden tests fail with a diff.
3. Regenerate the goldens with the real renderer and read the diff before you commit it:

```
cd content-build
node tests/update-mermaid-goldens.ts
```

   It writes `fixtures/expected-mermaid/renderer/<type>.svg` and `fixtures/expected-mermaid/build/`. There is one set of goldens, not one per platform.
4. Raise `POSTPROCESS_VERSION` only if the code in `src/` changed what is written. The cache key already holds the versions.

### Windows

`npm ci`, `npm run install:browser`, and `npm test` work in PowerShell 5.1 with Node 24: the tests start child processes with `process.execPath`, import by `file://` URL, and need no shell, and the golden SVGs are `-text` in `.gitattributes`, so a checkout does not change their line endings. The goldens are made on Linux and must pass on Windows with the same bytes (a failed golden test names the files that differ and shows the first differing bytes); if they do not, do not keep a second set: report the difference (rounding the numbers in the SVG or another layout setting are the options). To run it on Windows:

```
cd content-build
npm ci
npm run install:browser
npm test
```

## Building the courses

`npm run build -- <courses folder> <build folder>` (from the repo root: `make build-content`, which builds `courses/` into `build/`) checks every course and writes what the backend reads. Both folders are required (`/` or `\` both work); with fewer or more arguments it prints the usage on stderr and exits 2. The build folder is `build/` at the repo root, which `.gitignore` ignores.

- A course is every sub-folder of the courses folder whose name does not start with `.`. A file there, such as `courses/README.md`, is ignored. A link to a folder is an error.
- `COURSES` limits the build to some courses: a comma-separated list of course IDs (`COURSES=mcp-server,other`). Unset, empty, or only white space means every course. Each entry is trimmed. An ID with no folder, an ID given twice, and an empty entry (`a,,b`) fail the build and name the problem. `COURSES` does not change which courses `ids:check` looks at: it always covers every course. In PowerShell: `$env:COURSES = 'mcp-server'`.
- **All or nothing.** Every selected course is checked first with `validateCourse`, which includes the lesson ID and `CodeSteps` checks below. Every problem of every course is printed on stdout, as `<path>[:<line>[:<column>]]: error|warning: <message>`, with the path starting at the courses folder you gave, then `N error(s), M warning(s)`. If any course has an error, nothing in the build folder is created, changed, or removed. Only then does the build remove `<build>/private/`, `<build>/public/`, and `<build>/assets-map/` (and nothing else in the build folder), so the output of a course that was removed or left out does not stay, and write the courses.
- It refuses, with exit 1 and a message, a build folder that is the courses folder, contains it, or is inside it, and a build folder that is a file.
- Exit codes are those of `validate`: 0 built (warnings are allowed), 1 the content has errors (also: the courses folder or the build folder cannot be used, or `COURSES` is wrong), 2 bad command line, 3 the build's own setup is wrong (a component schema or `media-config.json` is not valid, see [Setup errors](#setup-errors)).
- On success the last line is `built <n> course(s) into <build folder>`.
- With no course in the courses folder (today `courses/` holds only `README.md`), `build` exits 0, prints `no courses found in <folder>` and `built 0 course(s)`, and still creates the empty `private/` and `public/`. A courses folder that does not exist exits 1 and names it. `COURSES` that names a course the folder does not have fails.
- The output is deterministic. Building the same courses twice, into two different folders, gives byte-identical trees, also when the course files use CRLF and a byte order mark. It has no timestamp, absolute path, or commit SHA. Every JSON file is UTF-8 without a byte order mark, with LF, a 2-space indent, and a final newline.

### The build folder

```
<build>/
├── private/                       # read by the backend only; never served as files
│   ├── courses/<course_id>.json                  # the manifest
│   ├── lessons/<course_id>/<lesson_id>.json      # one file per lesson
│   ├── quizzes/<course_id>/<chapter_id>.json     # with the answer keys (see Quizzes)
│   └── code/<course_id>/<chapter_id>.json        # the steps, and <chapter_id>-<hash>.zip (see Code steps)
├── public/assets/<course_id>/<stem>-<hash>.<ext> # the hashed assets (see Assets)
└── assets-map/<course_id>.json                   # original path to hashed name (see Assets)
```

`private/` and `public/` exist after every successful build. The Docker image of the backend holds this folder at `/app/course-build` (the variable `COURSE_BUILD_DIR`). Nothing that holds an answer key, an explanation, a lesson body, or a code step is under `public/` or `assets-map/`; a test checks it with sentinel strings.

**The manifest** `private/courses/<course_id>.json`:

```json
{
  "schema_version": 2,
  "course_id": "sample-course",
  "title": "Sample course",
  "description": "A small course that ...",
  "chapters": [
    {
      "id": "01-first-steps",
      "title": "First steps",
      "free_preview": true,
      "has_code": true,
      "lessons": [{ "id": "01-welcome", "title": "Welcome", "order": 1 }]
    }
  ]
}
```

`chapters` is in the order of `course.yaml`, and only the chapters it lists are here (a chapter in progress is not). `free_preview` says whether the chapter is in `free_preview` of `course.yaml`. `has_code` is true exactly when `private/code/<course_id>/<chapter_id>.json` exists. The lessons are sorted by `order`. A chapter's `title` is the trimmed `title` of the chapter in `course.yaml`, as typed: it is not empty, is one line, and has at most 100 characters (the `id` stays the folder name). `schema_version` is 2; it goes up when the shape of the manifest changes.

**A lesson file** `private/lessons/<course_id>/<lesson_id>.json` is `{ "course_id", "chapter_id", "lesson_id", "tree" }`. `tree` is the `compileLesson` tree after `rewriteAssetUrls`: asset references are `/api/courses/<course_id>/assets/<hashed name>`. The files are flat per course because lesson IDs are unique in a course.

### Checks added for the build

- **A lesson ID is used once in a course.** The ID is the `id` in the front matter, else the file name without `.mdx`. Two lessons with the same ID are an error that names the second file (and the line of its `id`) and the first file, whether it is two explicit IDs, an explicit ID equal to another lesson's file name, or the same file name in two chapters.
- **An explicit lesson `id` that is a Windows device name** (`con`, `nul`, `com1`, ...) is an error, because the ID becomes a file name in the build.
- **A `CodeSteps` tag names a real step and file.** `step` must be a step of the chapter's own `code/` folder, and `file` (when given) a path in that step, exactly as the files are listed, with `/`. A chapter with no `code/` folder, or with steps that have problems, makes every `CodeSteps` in it an error. The message names the lesson file, the line and column of the tag, and the step and file. `compileLesson` returns the tags (`codeSteps`, each with `step`, `file`, `line`, `column`) next to the references.

## Stable IDs

Chapter, lesson, and question IDs are the keys that progress, attempts, and feedback refer to, so a published one must not disappear without a note. `courses/<id>/ids.json` lists them and is checked in:

```json
{
  "course_id": "sample-course",
  "chapters": ["01-first-steps", "02-going-further"],
  "lessons": ["01-welcome", "setup", "01-next"],
  "questions": ["first-steps-1", "..."]
}
```

Chapters are in the order of `course.yaml`, lessons by chapter and then by `order`, questions by chapter and then by position. Only listed chapters count. The lists are flat per kind, so moving a lesson to another chapter is not a removal. A chapter folder is named `NN-slug`, so inserting or reordering chapters renames chapter IDs and needs notes. The file is written like the build's JSON files.

- `npm run ids:update -- <courses folder>` (`make update-content-ids`) validates every course and, only if none has an error, writes `ids.json` in each. Running it twice changes nothing.
- `npm run ids:check -- <courses folder>` (`make check-content-ids`, also part of `make check`) exits 1 and says `run npm run ids:update` if a course has no `ids.json`, or if its content, parsed (so line endings and a byte order mark do not matter), differs from the IDs the course has now. A hand-edited `ids.json` that hides a removal fails here.
- `npm run ids:check -- <courses folder> --base <git ref>` (`make check-content-ids-base BASE=origin/main`) also compares with the courses as of `git merge-base <ref> HEAD`. The lists in the `ids.json` of that commit are the published IDs. Every published chapter, lesson, or question ID that is not in the current `ids.json` needs a line in the course's `MIGRATIONS.md`:

  ```
  removed <kind> <id>: <reason>
  ```

  `<kind>` is `chapter`, `lesson`, or `question`, and `<reason>` is not empty. A leading `- ` or `* ` is allowed, and so are CRLF and a byte order mark. Any other line is prose and is ignored, except a line that starts with `removed ` and does not match the format, which is a warning that names the line. A note of the wrong kind does not count. Adding IDs never fails. A course with no `ids.json` at the base (a new course) passes. A course that was published and whose folder is gone fails, because v1 does not remove courses. A failure names the course, the kind, and the ID, and the note line to add.
- `<ref>` is passed to git without a shell. A ref that starts with `-` is rejected (exit 2), and so is one that is not a commit (exit 1). A shallow clone that lacks the base fails with a message that says to fetch more history; it never passes silently. A base made only of zeros (the first push of `main`) prints a notice and skips the comparison. The merge base means IDs that `main` gained after the branch was made are not reported as removed.
- With no course in the folder, `ids:update` and `ids:check` exit 0 with `no courses found in <folder>`. With `--base`, a course that was published still fails.

**In CI** the `content-build` job checks out the whole history (`fetch-depth: 0`) and runs `make build-content` and then `make check-content-ids-base`. The base comes from the step's `env`: for a pull request or a push to a branch other than `main`, it is `origin/main`; for a push to `main`, it is the commit before the push (`github.event.before`).

## Layout

- `src/course.ts` - `validateCourse`: the course folder and `course.yaml`
- `src/chapter.ts` - one chapter: `lessons/`, `quiz.yaml`, and the lesson front matter; `lessonId` and `splitFrontMatter` are shared helpers
- `src/quiz.ts` - `compileQuiz`: the quiz rules, the limits, and the data to write; `src/write-quizzes.ts` - `writeQuizzes`
- `src/code-steps.ts` - the code step checks and `CODE_LIMITS`; `src/windows-paths.ts` - the Windows path rule; `src/text.ts` - normalizing and splitting text
- `src/assets.ts` - the allowed file types, the table of props that refer to files, and the hashed names; `src/asset-files.ts` - the checks of the files in `assets/`; `src/svg.ts` - the SVG rules; `src/media-config.ts` - `loadMediaConfig`; `src/media-url.ts` - where a `Video` URL may point; `src/references.ts` - the checks of a lesson's references; `src/rewrite-assets.ts` - `rewriteAssetUrls`; `src/write-assets.ts` - `writeAssets`
- `src/step-diff.ts` - `diffSteps`; `src/chapter-zip.ts` - `buildChapterZip`; `src/write-code-steps.ts` - `writeCodeSteps`
- `src/lesson.ts` - `compileLesson`; `src/lesson-tree.ts` - the tree types, the check against its schema, and `serializeTree`; `src/component-schemas.ts` - reads the component schemas and `SetupError`; `src/url.ts` - the URL rule
- `src/compile-cli.ts` and `src/compile.ts` - the `compile` command and its entry point
- `src/browser-install.ts` and `src/install-browser.ts` - the `install:browser` command and its entry point
- `src/diagram-source.ts` - the source checks and line numbers of a `Diagram`; `src/diagrams.ts` - `renderDiagrams`; `src/diagram-svg.ts` - `finishSvg` and the accessible name; `src/mermaid-render.ts` - the browser; `src/mermaid-cache.ts` - the cache; `src/mermaid-config.ts` - `mermaid-config.json`; `src/mermaid-versions.ts` - the installed versions (see [Diagrams](#diagrams))
- `src/build-cli.ts` and `src/build.ts` - the `build` command and its entry point; `src/courses-folder.ts` - finding the courses and checking where the build may write; `src/write-course.ts` - the manifest and the lesson files
- `src/ids.ts` - the IDs of a course and `ids.json`; `src/migrations.ts` - the notes in `MIGRATIONS.md`; `src/git.ts` - the git commands of the ID check (no shell); `src/ids-cli.ts`, `src/ids-update.ts`, and `src/ids-check.ts` - the `ids:update` and `ids:check` commands and their entry points
- `src/schema.ts` - ajv checks, with messages that name the field instead of the schema keyword
- `schemas/` - the JSON Schemas for `course.yaml`, the lesson front matter, `quiz.yaml`, and the lesson tree (component props schemas live in `frontend/src/content-components/schemas/`, not here)
- `src/folder.ts`, `src/yaml-file.ts`, `src/report.ts`, `src/problem.ts` - reading folders and YAML, collecting and printing problems
- `src/cli.ts` and `src/validate.ts` - the `validate` command and its entry point
- `fixtures/quizzes/valid/<case>.yaml` and `fixtures/quizzes/invalid/<case>.yaml` - single quiz files; a test puts one into a copy of the valid course as `chapters/01-first-steps/quiz.yaml`
- `fixtures/lessons/valid/<case>.mdx` with `<case>.json` beside it (the golden tree), `fixtures/lessons/invalid/<case>.mdx` - one lesson per rejection; `fixtures/components/` - the small schema folder that the rule tests use
- `fixtures/expected/` - the golden build folder for the valid course (`private/`, `public/`, `assets-map/`: the quizzes, code steps, assets, manifest, and lesson files), and the golden rewritten tree (`lessons/all-assets.json`, which is not part of a build folder); `fixtures/svg/` - one SVG per SVG rule; `fixtures/lessons/assets/` - the lesson that `rewriteAssetUrls` is tested with
- `fixtures/mermaid/` - the courses folder with the course `mermaid-course` (a `Diagram` of each supported type); `fixtures/expected-mermaid/` - its golden output (`renderer/<type>.svg` and `build/`), regenerated by `tests/update-mermaid-goldens.ts`
- `fixtures/valid/` - a valid course; `fixtures/invalid/<case>/` - one course per rule it breaks; `fixtures/warnings/<case>/` - courses that are valid but get a warning. Each folder's name is the course `id`, except `invalid/id-mismatch`.
- `tests/` - the Vitest tests. The ID check tests create a temporary git repository (no network, a fixed author and fixed dates). Cases that depend on line endings or a byte order mark are written to a temporary folder by the test, so git's line-ending settings cannot change them.

Names are looked up in folder listings and compared exactly, never opened by a typed name, so the checks give the same result on Windows, macOS, and Linux.
