# courses

Course content, one folder per course: `courses/<id>/`. The content build (`content-build/`) rejects a folder that breaks the format below. No course exists here yet; the first one (`courses/mcp-server`) comes with [#26](https://github.com/davbaster/mcp-lab/issues/26) onward. [`content-build/fixtures/valid/sample-course`](../content-build/fixtures/valid/sample-course) shows a small valid course.

```
courses/<id>/
├── course.yaml                  # id, title, description, chapter order, free-preview chapters
├── assets/                      # images, .glb models, diagram sources, .vtt captions
├── ids.json                     # published IDs (generated, checked in #12)
├── MIGRATIONS.md                # notes for removed IDs (checked in #12)
└── chapters/
    └── 01-slug/                 # NN-slug: NN is the chapter's position in course.yaml
        ├── lessons/
        │   └── 01-slug.mdx      # NN-slug.mdx: front matter, then the MDX body
        ├── code/                # step-1/, step-2/, ... (see Code steps below)
        └── quiz.yaml            # the chapter quiz (see Quizzes below)
```

The files in `assets/` and how lessons refer to them are described in [Assets](../content-build/README.md#assets).

## course.yaml

Exactly these keys, and no others:

```yaml
id: sample-course          # the course folder's name
title: Sample course
description: One sentence about the course.
chapters:                  # chapter folder names, in order; at least one
  - 01-first-steps
  - 02-going-further
free_preview:              # chapters visitors can read without an account; may be empty
  - 01-first-steps
```

- `id`, `title`, and `description` are non-empty strings. `chapters` and `free_preview` are lists of strings.
- `id` and every chapter name use only lowercase letters, digits, and hyphens. Chapter names are unique.
- `free_preview` names only chapters that are in `chapters`.

## Chapters and lessons

- Each chapter listed in `chapters` is a folder `chapters/NN-slug/`, where `NN` is two digits and equals the chapter's position (`01` for the first, `02` for the second).
- A chapter has a `lessons/` folder with at least one `.mdx` file, and a `quiz.yaml` (see [Quizzes](#quizzes)).
- A lesson file is named `NN-slug.mdx` (lowercase letters, digits, hyphens) and starts with front matter between `---` lines:

  ```
  ---
  title: Welcome
  order: 1
  ---
  ```

  `title` is a non-empty string and `order` an integer of 1 or more. An optional `id` (lowercase letters, digits, hyphens) sets a stable lesson ID. No other key is allowed. The `order` values in a chapter are unique and run 1 to N with no gaps. A file-name prefix that differs from `order` is only a warning.
- A chapter folder that is not listed in `chapters` is an error if it has `lessons/` or `quiz.yaml`, so no chapter is silently ignored. A folder with only `code/` is a chapter in progress: the build warns and does not publish it, so code steps can land before their lessons.
- Anything else (a stray file, a subfolder in `lessons/`, a non-`.mdx` file there) is a warning. `.DS_Store` and `Thumbs.db` are ignored.
- Names must match exactly, including capitals, on every platform: `01-Tools` is not `01-tools`.
- YAML and MDX files may use CRLF line endings and start with a UTF-8 byte order mark.
- The body of every lesson is compiled when you check the course (see [Lessons](#lessons)).

## Lessons

A lesson is the front matter (see above) followed by the body: restricted MDX, which is Markdown plus a few components. The build turns the body into a JSON tree. It never runs anything in a lesson, and it rejects a lesson with a message that names the file, the line, and the column.

````mdx
---
title: Your first tool
order: 2
---

# Your first tool

A tool is a function that the model can call. Register it with `@mcp.tool()`:

```python
@mcp.tool()
def add(a: int, b: int) -> int:
    return a + b
```

<Callout type="tip" title="Type hints matter">

The type hints become the tool's input schema, so always write them.

</Callout>

<Tabs>

<Tab label="macOS">

Run `uv run server.py` in Terminal.

</Tab>

<Tab label="Windows">

Run `uv run server.py` in PowerShell.

</Tab>

</Tabs>

<Image src="images/tools.png" alt="A model calling a tool" />

See the [MCP specification](https://modelcontextprotocol.io/) for more.

<CodeSteps step="1" file="server.py" />
````

**You may write**

- Markdown: headings, paragraphs, *emphasis*, **strong text**, `inline code`, links, images, ordered and unordered lists (also nested), block quotes, horizontal rules, hard line breaks (two spaces or a backslash at the end of a line), and fenced code blocks with an optional language (` ```python `).
- These components, each with the props below. Put the opening tag and the closing tag on their own lines, with a blank line before and after what is between them. A component that takes no children is written as one self-closing tag on its own line.

  | Component | Props | Children |
  |---|---|---|
  | `Video` | `src`, `title`; optional `captions`, `poster` | none |
  | `Model3D` | `src`, `alt`, `poster` | none |
  | `Diagram` | `alt`, and exactly one of `src` (a URL) or `source` (Mermaid text) | none |
  | `Image` | `src`, `alt` | none |
  | `Callout` | `type` (`tip`, `warning`, or `note`); optional `title` | Markdown and components |
  | `Tabs` | none | two or more `Tab` |
  | `Tab` (only inside `Tabs`) | `label` | Markdown and components |
  | `CodeSteps` | `step` (a whole number of 1 or more); optional `file` | none |

- Props are written as text in quotes (`alt="A server"`). A prop must not be empty. The text can hold character references such as `&amp;`.
- Links and URL props (`src`, `captions`, `poster`) that are relative (`../a.md`, `/x`, `#section`, `?q=1`) or start with `http:`, `https:`, or `mailto:`.
- Code that only looks like code: inside a code fence or in `inline code`, anything goes (`import x`, `<script>`, `{1 + 1}`, `onClick`). In ordinary text, write a brace as `\{`. The text `a < b` is fine.

**You may not write** (each is an error)

- JavaScript: `{1 + 1}` in text or in a prop, a spread `{...props}`, a comment `{/* note */}`, or `import` and `export` lines.
- HTML: `<div>`, `<script>`, `<iframe>`, or any tag that starts with a lowercase letter; fragments (`<>`); names such as `<a:b>` or `<a.b>`.
- An attribute whose name starts with `on` (`onClick`, `onload`), in any letter case.
- A component that is not in the table, a prop that is not listed, a prop written twice, a missing or empty required prop, a value that does not fit (a `Callout` of type `danger`), or children that the component does not take.
- A component inside a paragraph (`<Callout>text</Callout>` on one line).
- A URL with any other scheme (`javascript:`, `data:`, `vbscript:`, `file:`), and a URL that starts with `//`.
- Reference-style links and images (`[text][label]`, `![alt][label]`) and their definitions (`[label]: url`), and anything after the language on a code fence (` ```python title="x" `).
- Tables, strikethrough, task lists, and footnotes are not part of the format: they are not parsed and stay plain text. Ask for them in an issue if a course needs them.

A tag that is not closed, or closed by another tag, is a parse error: the build reports the first one and stops checking that lesson (the other lessons are still checked). To try a lesson, run `npm run compile -- <lesson.mdx>` in `content-build/`, which prints the tree or the problems. The tree format, the schemas, and how to add a component are in [`content-build/README.md`](../content-build/README.md#lessons).

## Code steps

A chapter can have a `code/` folder with the project as it grows, one folder per step: `code/step-1/`, `code/step-2/`, and so on. Each step is the whole project at that point (every file, not only what changed), and it must be a complete, working project. The build compares each step with the one before it, so the step viewer can highlight the lines that changed, and it zips the last step of each chapter for the download button.

```
chapters/03-tools/code/
├── step-1/
│   └── server.py
└── step-2/
    ├── server.py
    └── src/
        └── util.py
```

- Step folders are named `step-` and a whole number with no leading zero, spelled exactly like that: `step-1`, `step-2`, `step-10`. `Step-1`, `step-01`, and `step-0` are errors, and so is any other file or folder in `code/` (a `README.md`, a `draft/` folder). Numbers run 1, 2, 3 with no gaps, and a chapter has at most 20 steps.
- A step has at least one file, at most 100 files, and each file is at most 256 KiB (262,144 bytes). Empty folders do not count as files and are not shipped; `.DS_Store` and `Thumbs.db` are ignored.
- Every file is UTF-8 text: no binary files and no NUL characters. An empty file is fine. CRLF line endings and a byte order mark are fine too: the build turns `\r\n` into `\n` and removes one leading byte order mark, so the viewer, the Copy button, and the ZIP all show the same text.
- Do not commit `__pycache__`, `.venv`, `node_modules`, `.pytest_cache`, or `.pyc` files in a step. They are errors, even where `.gitignore` would hide them.
- A step may hold only plain files and folders. A symbolic link is an error: the build never follows links.
- Every path in a step must also extract on Windows, so these are errors: a name with `< > : " \ | ? *` or a control character, a name ending in a space or a dot, a Windows device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1` to `COM9`, `LPT1` to `LPT9`, with or without an extension, in any case), two names in one folder that differ only in letter case, and a path inside the step longer than 100 characters (`src/util.py` is 11).
- A renamed file shows in the viewer as one deleted file and one new file; the build does not detect renames.
- A chapter folder that has only `code/` (a chapter in progress) gets the same checks, but nothing is built from it until it is listed in `course.yaml`.

Step data and ZIPs are private build data, served by the backend under the same access rules as the chapter's lessons. See [`content-build/README.md`](../content-build/README.md#code-steps).

## Quizzes

Each listed chapter has a `quiz.yaml`: a mapping with exactly one key, `questions`, a list of exactly 5 questions.

```yaml
questions:
  - id: tools-1                 # unique in the whole course; lowercase letters, digits, hyphens
    text: What does a tool return to the client?
    options:                    # 2 or 3 options
      - id: a                   # unique in the question; lowercase letters, digits, hyphens
        text: A result
      - id: b
        text: A web page
    correct: a                  # the id of exactly one option
    explanation: |
      A tool returns a result, which the client passes to the model.
    lesson: 01-intro            # the id of a lesson in this chapter
  - id: tools-2
    text: What does this program print?
    snippet:                    # optional
      language: python          # no white space
      code: |
        def add(a, b):
            return a + b

        print(add(1, 2))
    options:
      - id: a
        text: "3"               # quoted, so that it is a string and not a number
      - id: b
        text: "12"
      - id: c
        text: Nothing
    correct: a
    explanation: The function adds its two arguments, so the program prints 3.
    lesson: 02-crud
  - id: tools-3
    text: Which decorator registers a function as a tool?
    options:
      - id: a
        text: "@mcp.tool()"
      - id: b
        text: "@mcp.route()"
    correct: a
    explanation: The `@mcp.tool()` decorator adds the function to the server's tools.
    lesson: 01-intro
  - id: tools-4
    text: How does the model know what a tool does?
    options:
      - id: a
        text: From its name and description
      - id: b
        text: From its source code
      - id: c
        text: It does not
    correct: a
    explanation: The client sends the tool's name, description, and input schema to the model.
    lesson: 01-intro
  - id: tools-5
    text: What should a tool do with a bad argument?
    options:
      - id: a
        text: Return a clear error
      - id: b
        text: Crash the server
    correct: a
    explanation: A clear error lets the model fix the call and try again.
    lesson: 02-crud
```

- A question has `id`, `text`, `options`, `correct`, `explanation`, and `lesson`, and may have `snippet`. An option has `id` and `text`. A snippet has `language` and `code`. No other key is allowed anywhere.
- All of these values are strings, except `options` (a list) and `snippet` (a mapping). A YAML number or boolean is not a string, so quote it: `text: "42"`.
- Text fields are plain text: nothing here parses Markdown. `text`, option `text`, `explanation`, `lesson`, and `snippet.code` must not be empty or only white space. `explanation` is at most 1000 characters and `snippet.code` at most 2000, counted as Unicode characters after CRLF becomes LF. Text, option text, and explanation are trimmed when the quiz is built; code is kept exactly, because indentation matters.
- A chapter has exactly 5 questions, and a question 2 or 3 options. `correct` must be the `id` of exactly one option. Two options of a question may not have the same `id`, nor the same text (compared after trimming, with the same capitals).
- Question IDs are unique in the whole course, not only in the chapter. IDs are stable once published, so start them with something that names the chapter or topic.
- `lesson` is the ID of a lesson in the **same chapter**. A lesson's ID is the `id` in its front matter when it has a valid one, otherwise its file name without `.mdx`. It must match exactly, capitals included: a lesson `01-welcome.mdx` is `01-welcome`, and a lesson with `id: setup` is `setup` (not `02-setup`). The link is not checked when the chapter has no lessons, which is reported on its own.
- The order of the questions and of the options is the order in the file. The build does not shuffle; the backend does.
- A problem names the file, the line, and the question by its `id` (or its position, such as `question 3`, when it has no usable `id`). It never repeats the question text, an option, an explanation, or code, because quizzes are private.

Quiz answers and explanations are private build data: the build writes them under `private/quizzes/`, which only the backend reads. See [`content-build/README.md`](../content-build/README.md).

Check a course with `cd content-build` then `npm run validate -- ../courses/<id>`.
