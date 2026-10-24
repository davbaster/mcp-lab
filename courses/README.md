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
        └── quiz.yaml            # the chapter quiz (checked in #11)
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
- A chapter has a `lessons/` folder with at least one `.mdx` file, and a `quiz.yaml`.
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

Check a course with `cd content-build` then `npm run validate -- ../courses/<id>`.
