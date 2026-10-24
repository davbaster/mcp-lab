# content-build

A Node + TypeScript tool that validates the courses in `courses/` and compiles their restricted MDX to JSON. So far it validates the folder layout, `course.yaml`, and the lesson front matter. The format is described in [`courses/README.md`](../courses/README.md).

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

`file` is the path inside the course folder, with `/`. Later steps (#8, #11, #12) add their checks next to the ones here and reuse `validateCourse`.

## Layout

- `src/course.ts` - `validateCourse`: the course folder and `course.yaml`
- `src/chapter.ts` - one chapter: `lessons/`, `quiz.yaml`, and the lesson front matter
- `src/schema.ts` - ajv checks, with messages that name the field instead of the schema keyword
- `schemas/` - the JSON Schemas for `course.yaml` and the lesson front matter (component props schemas live in `frontend/src/content-components/schemas/`, not here)
- `src/folder.ts`, `src/yaml-file.ts`, `src/report.ts`, `src/problem.ts` - reading folders and YAML, collecting and printing problems
- `src/cli.ts` and `src/validate.ts` - the `validate` command and its entry point
- `fixtures/valid/` - a valid course; `fixtures/invalid/<case>/` - one course per rule it breaks; `fixtures/warnings/<case>/` - courses that are valid but get a warning. Each folder's name is the course `id`, except `invalid/id-mismatch`.
- `tests/` - the Vitest tests. Cases that depend on line endings or a byte order mark are written to a temporary folder by the test, so git's line-ending settings cannot change them.

Names are looked up in folder listings and compared exactly, never opened by a typed name, so the checks give the same result on Windows, macOS, and Linux.
