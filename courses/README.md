# courses

Course content, one folder per course: `courses/<id>/`. The content build (`content-build/`) rejects a folder that breaks the format below. No course exists here yet; the first one (`courses/mcp-server`) comes with [#26](https://github.com/davbaster/mcp-lab/issues/26) onward. [`content-build/fixtures/valid/sample-course`](../content-build/fixtures/valid/sample-course) shows a small valid course.

```
courses/<id>/
├── course.yaml                  # id, title, description, chapter order, free-preview chapters
├── assets/                      # images, .glb models, diagram sources (checked in #9)
├── ids.json                     # published IDs (generated, checked in #12)
├── MIGRATIONS.md                # notes for removed IDs (checked in #12)
└── chapters/
    └── 01-slug/                 # NN-slug: NN is the chapter's position in course.yaml
        ├── lessons/
        │   └── 01-slug.mdx      # NN-slug.mdx: front matter, then the MDX body
        ├── code/                # step-N/ folders (checked in #10)
        └── quiz.yaml            # the chapter quiz (see Quizzes below)
```

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
