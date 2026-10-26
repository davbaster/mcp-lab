# Design system

How the course app looks and behaves. Read this before any UI task. The tokens below live as CSS custom properties in `frontend/src/styles/tokens.css` (created in #17). Components use the tokens, never raw values.

v1 has one light theme. Dark mode is not in the plan.

## Principles

- **Reading comes first.** Lessons are long-form text. Keep a calm page, a narrow text column, and generous line height.
- **Never rely on color alone.** Every status, state, and change has a text label or marker as well as a color.
- **Works on a phone.** Every page works at 360px wide with no sideways page scroll.
- **Accessible by default.** Target WCAG 2.2 AA. Use native elements (`button`, `a`, `dialog`, `fieldset`, `input type="radio"`) before custom ones.
- **Say what to do next.** Every empty, error, and locked state tells the learner their next step.

## Color

Contrast ratios are against the background shown, computed with the WCAG formula.

| Token | Value | Use | Contrast |
|---|---|---|---|
| `--color-bg` | `#ffffff` | page background | |
| `--color-surface` | `#f6f7f9` | cards, header, code background | |
| `--color-border` | `#d0d5dd` | dividers and card edges (decorative) | |
| `--color-border-strong` | `#8a94a6` | form field borders | 3.06:1 on bg (non-text, meets 3:1) |
| `--color-text` | `#1d2330` | body text | 15.7:1 on bg, 14.7:1 on surface |
| `--color-text-muted` | `#4a5363` | secondary text, hints | 7.8:1 on bg, 7.2:1 on surface |
| `--color-primary` | `#1f5fbf` | links, primary buttons, focus ring, "In progress" | 6.1:1 on bg; white text on it 6.1:1 |
| `--color-primary-hover` | `#174a96` | hover and active | 8.6:1 on bg |
| `--color-success` | `#1a7f37` | "Passed", "Correct" | 5.1:1 on bg |
| `--color-warning` | `#9a6700` | warning callout label | 4.9:1 on bg |
| `--color-danger` | `#c62828` | errors, "Incorrect", "Deleted" | 5.6:1 on bg |
| `--color-tip-bg` | `#eaf6ee` | tip callout background | text 14.2:1, success label 4.6:1 |
| `--color-warning-bg` | `#fff6e0` | warning callout background | text 14.6:1, warning label 4.5:1 |
| `--color-note-bg` | `#eaf1fb` | note callout background | text 13.8:1, primary label 5.4:1 |
| `--color-danger-bg` | `#fdecec` | error message box | danger text 4.9:1 |
| `--color-changed-line` | `#fff3c4` | changed lines in code step mode | text 14.1:1 |
| `--color-code-comment` | `#58606e` | code: comments | 5.91:1 on surface |
| `--color-code-constant` | `#0550ae` | code: numbers, constants, keys of values | 7.08:1 on surface |
| `--color-code-keyword` | `#a0111f` | code: keywords, JSON and YAML keys | 7.55:1 on surface |
| `--color-code-parameter` | `#953800` | code: function parameters | 6.89:1 on surface |
| `--color-code-function` | `#6639ba` | code: functions, types, attributes | 6.85:1 on surface |
| `--color-code-string` | `#116329` | code: Markdown list markers and inline code | 6.90:1 on surface |
| `--color-code-string-expression` | `#0a3069` | code: quoted strings and tags | 11.95:1 on surface |
| `--color-code-punctuation` | `#3f4858` | code: separators and brackets | 8.60:1 on surface |
| `--color-code-link` | `#1f5fbf` | code: Markdown links | 5.68:1 on surface |

Any new color must meet 4.5:1 for text and 3:1 for UI parts and focus indicators. Check it and add it to this table in the same change.

## Typography

- **Text font:** the system stack: `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`. No web fonts in v1.
- **Code font:** `ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace`.
- **Sizes** (`--font-size-*`): `sm` 14px, `base` 16px, `lg` 18px, `xl` 20px, `2xl` 24px, `3xl` 30px. Lesson body text is `lg` on screens 768px and wider, and `base` below that.
- **Line height:** 1.6 for body text, 1.25 for headings, 1.5 for code.
- **Headings:** one `h1` per page (the page or lesson title). Do not skip levels.
- Use sentence case for headings, buttons, and labels ("Take the quiz", not "Take The Quiz").

## Spacing, size, and shape

- **Spacing scale** (`--space-*`): 4, 8, 12, 16, 24, 32, 48, 64 px. Use only these.
- **Radius:** `--radius` 6px for buttons, inputs, cards, and callouts. No shadows except for the open dialog.
- **Touch targets:** buttons, links in navigation, tabs, and radio rows are at least 44×44px.

## Layout

- **Breakpoints:** 360px (smallest supported), 768px (tablet), 1280px (desktop). Check every page at these three widths.
- **Page width:** app pages (course list, dashboard) up to 1100px wide. The lesson text column is at most 72 characters wide (`72ch`). Code viewers, videos, and diagrams may use the full content width.
- **Side padding:** 16px below 768px, 24px from 768px.
- **No sideways page scroll.** Wide content (code, tab lists, tables) scrolls inside its own box.
- **Header:** app name on the left (links to `/`). On the right: "Sign in" and "Create account" for visitors, or the username and "Sign out" for learners. The "Send feedback" button is in the header on every page (#25).

## Interaction states

- **Focus:** every interactive element shows `outline: 3px solid var(--color-primary); outline-offset: 2px` on `:focus-visible`. Never remove focus outlines without a replacement.
- **Hover:** links underline. Buttons darken to `--color-primary-hover`.
- **Disabled:** use the `disabled` attribute. Show it with a muted color and `cursor: not-allowed`, and keep the text readable (4.5:1).
- **In flight:** while a request runs, disable the button that started it, so a double click sends once. Keep its label, or change it to say what is happening ("Signing in…").

## Components

### Buttons and links

- **Primary button:** `--color-primary` background, white text. One per view, for the main action (Submit answers, Resume, Sign in).
- **Secondary button:** white background, `--color-border-strong` border, `--color-text` text.
- Use a link (`a`) to go somewhere, and a button to do something.

### Status labels

Chapter status is a small label with text, never color alone:

| Status | Text | Color |
|---|---|---|
| locked | "Locked" | `--color-text-muted` |
| in progress | "In progress" | `--color-primary` |
| passed | "Passed" | `--color-success` |

Quiz results use "Correct" (`--color-success`) and "Incorrect" (`--color-danger`). Code step files use "New" (`--color-success`), "Changed" (`--color-primary`), and "Deleted" (`--color-danger`), as text inside the file tab next to the path, each at least 4.5:1 on `--color-bg` and `--color-surface`.

### Forms

- Labels above fields, always visible. No placeholder-only labels.
- Field errors appear below the field in `--color-danger`, linked with `aria-describedby`, and the field gets `aria-invalid="true"`.
- Errors that are not about one field (for example `invalid_credentials`) appear above the form in a box with `--color-danger-bg` and `role="alert"`.
- Use the right `autocomplete` values (`username`, `new-password`, `current-password`).
- Never echo a password in any message.

### Messages and states

Use these words, so the app sounds the same everywhere:

| State | Text |
|---|---|
| Loading | "Loading…" (reserve the space the content will use) |
| Failed request | the error's `message`, then a "Try again" button |
| Not found | "<Thing> not found", with a link back (to `/` or the dashboard) |
| Locked chapter | "This chapter is locked. Pass the previous chapter's quiz to unlock it." |
| Visitor on a learner page | "Sign in to <do the thing>", with a link to `/login?next=<this page>` |
| Feedback sent | "Thanks – we'll review it" |

Errors from the API always use the shared shape. Show its `message`; branch on its `code`.

### Dialog

Use the native `<dialog>` element as a modal. Focus moves into it and stays there; Escape closes it; focus returns to the control that opened it. Below 480px wide it fills the screen.

### Callout

Three variants, each with a text label at the start: "Tip" (`--color-tip-bg`, label in `--color-success`), "Warning" (`--color-warning-bg`, label in `--color-warning`), and "Note" (`--color-note-bg`, label in `--color-primary`). A 4px left border in the label color.

### Tabs

Follow the WAI-ARIA tabs pattern: `tablist`, `tab`, and `tabpanel` roles; arrow keys move between tabs; Home and End jump to the ends. The selected tab has a 3px bottom border in `--color-primary` and bold text. If tabs do not fit, the tab list scrolls sideways inside itself.

### Code

- Background `--color-surface`, code font, `--radius` corners, and 16px padding.
- Syntax highlighting uses Shiki's CSS-variables theme (chosen in #21). Each token gets a fixed class (`code-token-keyword`, ...) that sets one of the `--color-code-*` tokens above, all at least 4.5:1 on the code background (and on `--color-changed-line`). Code that is not a token uses `--color-text`. No color is set inline.
- Line numbers in `--color-text-muted`, not selectable.
- Changed lines in step mode: `--color-changed-line` background plus a 3px `--color-primary` bar in the line-number gutter, with screen-reader text "changed".
- Step mode: above the tabs, "Step N of M" with the line of changes (or "First step: every file is new.") in one `role="status"` element, and the secondary buttons "Previous step" and "Next step" in the same row. The first step marks no line. A file that only lost lines shows the note "Lines were removed from this file in this step." above its code. The ZIP hint names the last step until the last step is shown.
- Code fences in lessons and quiz snippets use the same classes and colors as the code viewer, for the languages the viewer highlights; others stay plain text. A lesson fence has a Copy button above it, at the top right; a quiz snippet has none.
- Copy buttons sit at the top right of the code block and say "Copy", then "Copied" for 2 seconds (announced with `aria-live="polite"`).
- Code viewers (`CodeSteps`) use the full content width. Long lines scroll inside the code area and never wrap. If copying fails, the button says "Copy failed – select the code to copy it" until the learner presses it again or chooses another file.

### Media

- Images, diagrams, videos, and 3D models never grow wider than the content area.
- Videos and embeds keep a 16:9 frame. Never autoplay.
- Images and diagrams always have alt text (required by the content build).
- With `prefers-reduced-motion: reduce`, nothing animates or auto-rotates.

## Icons

No icon library in v1. Text labels carry the meaning. If an icon helps (for example a lock beside "Locked"), use a small inline SVG with `aria-hidden="true"` next to the text, never instead of it.

## Accessibility checklist for every UI change

- [ ] Works with the keyboard alone, in a logical order, with a visible focus.
- [ ] Every control has an accessible name (label, `aria-label`, or visible text).
- [ ] Status, errors, and changes are not shown by color alone.
- [ ] Text and UI contrast meet the ratios above.
- [ ] Page has one `h1`, headings in order, and a `document.title`.
- [ ] No sideways page scroll at 360px. Screenshots at 360, 768, and 1280px are in the PR.
- [ ] Dynamic results (quiz result, form errors, "Copied") are announced or receive focus.
