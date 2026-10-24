// ids:check --base: a published chapter, lesson, or question ID that disappears needs a note in MIGRATIONS.md.
// Every test builds its own git repository in a temporary folder (no network, a fixed author and fixed dates).

import { cpSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { coursesFolder, runIds } from "./build-support.ts";
import { git, makeRepo, read } from "./git-repo.ts";
import type { Repo } from "./git-repo.ts";
import { temporaryFolder } from "./helpers.ts";

const COURSE = "courses/sample-course";
const WELCOME = `${COURSE}/chapters/01-first-steps/lessons/01-welcome.mdx`;
const FIRST_QUIZ = `${COURSE}/chapters/01-first-steps/quiz.yaml`;
const MIGRATIONS = `${COURSE}/MIGRATIONS.md`;
const slashes = (path: string) => path.replaceAll("\\", "/");

function check(repo: Repo, base = "main") {
  return runIds("check", [repo.courses, "--base", base]);
}

/** Branches off main, as a pull request does. */
function branch(repo: Repo, name = "feature") {
  repo.git("checkout", "--quiet", "-b", name);
}

/** Renames the lesson file `01-welcome` to `01-hello` (the quiz links to it by id). */
function renameWelcome(repo: Repo) {
  repo.put(`${COURSE}/chapters/01-first-steps/lessons/01-hello.mdx`, read(repo, WELCOME));
  repo.put(WELCOME, null);
  repo.put(FIRST_QUIZ, read(repo, FIRST_QUIZ).replaceAll("lesson: 01-welcome", "lesson: 01-hello"));
  repo.update();
  repo.commit("rename the lesson");
}

describe("a lesson that is renamed", () => {
  it("fails without a note, names the course, the kind, and the ID, and says which line to add", () => {
    const repo = makeRepo();
    branch(repo);
    renameWelcome(repo);

    const result = check(repo);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    const line = result.stdout.split("\n").find((text) => text.includes("`01-welcome`")) ?? "";
    expect(line.startsWith(`${slashes(repo.courses)}/sample-course/ids.json: error: course \`sample-course\`: the lesson \`01-welcome\` was published`)).toBe(true);
    expect(line).toContain("add the line `removed lesson 01-welcome: <reason>` to ");
    expect(line).toContain("/sample-course/MIGRATIONS.md");
    expect(result.stdout).toContain("1 error(s), 0 warning(s)");
  });

  it("passes with a note", () => {
    const repo = makeRepo();
    branch(repo);
    renameWelcome(repo);
    repo.put(MIGRATIONS, "# Migrations\n\nremoved lesson 01-welcome: renamed to 01-hello\n");

    const result = check(repo);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ids ok in 1 course(s)");
  });

  it("does not accept a note of the wrong kind", () => {
    const repo = makeRepo();
    branch(repo);
    renameWelcome(repo);
    repo.put(MIGRATIONS, "removed question 01-welcome: wrong kind\nremoved chapter 01-welcome: wrong kind\n");

    const result = check(repo);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("the lesson `01-welcome` was published");
  });

  it("does not accept a note for another ID", () => {
    const repo = makeRepo();
    branch(repo);
    renameWelcome(repo);
    repo.put(MIGRATIONS, "removed lesson 01-hello: the new name, not the old\n");

    expect(check(repo).code).toBe(1);
  });
});

describe("a changed explicit lesson id", () => {
  it("fails without a note and passes with one", () => {
    const repo = makeRepo();
    branch(repo);
    const setup = `${COURSE}/chapters/01-first-steps/lessons/02-setup.mdx`;
    repo.put(setup, read(repo, setup).replace("id: setup", "id: setup-tools"));
    repo.put(FIRST_QUIZ, read(repo, FIRST_QUIZ).replaceAll("lesson: setup", "lesson: setup-tools"));
    repo.update();
    repo.commit("change the id");

    const failed = check(repo);
    repo.put(MIGRATIONS, "- removed lesson setup: the id says what the lesson does now\n");
    const passed = check(repo);

    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain("the lesson `setup` was published");
    expect(passed.code).toBe(0);
  });
});

describe("IDs that are added", () => {
  it("never fail: a new lesson, chapter, and question pass without a note", () => {
    const repo = makeRepo();
    branch(repo);
    repo.put(`${COURSE}/chapters/02-going-further/lessons/02-more.mdx`, "---\ntitle: More\norder: 2\n---\n\n# More\n");
    repo.put(FIRST_QUIZ, read(repo, FIRST_QUIZ).replace("id: first-steps-5", "id: first-steps-5"));
    repo.update();
    repo.commit("add a lesson");

    expect(check(repo).code).toBe(0);
  });
});

describe("a removed chapter, with its lessons and questions", () => {
  function removeSecondChapter(repo: Repo) {
    repo.put(`${COURSE}/chapters/02-going-further`, null);
    repo.put(`${COURSE}/course.yaml`, read(repo, `${COURSE}/course.yaml`).replace("  - 02-going-further\n", ""));
    repo.update();
    repo.commit("remove the chapter");
  }

  it("fails once for the chapter, its lesson, and each of its questions", () => {
    const repo = makeRepo();
    branch(repo);
    removeSecondChapter(repo);

    const result = check(repo);
    const errors = result.stdout.split("\n").filter((line) => line.includes(": error: "));

    expect(result.code).toBe(1);
    expect(errors).toHaveLength(1 + 1 + 5);
    expect(errors.filter((line) => line.includes("the chapter `02-going-further`"))).toHaveLength(1);
    expect(errors.filter((line) => line.includes("the lesson `01-next`"))).toHaveLength(1);
    expect(errors.filter((line) => line.includes("the question `going-further-"))).toHaveLength(5);
  });

  it("passes when every removed ID has a note", () => {
    const repo = makeRepo();
    branch(repo);
    removeSecondChapter(repo);
    repo.put(
      MIGRATIONS,
      [
        "# Migrations",
        "",
        "We cut the second chapter.",
        "* removed chapter 02-going-further: cut from the course",
        "- removed lesson 01-next: it was in that chapter",
        ...[1, 2, 3, 4, 5].map((n) => `removed question going-further-${n}: it was in that chapter`),
        "",
      ].join("\n"),
    );

    expect(check(repo).code).toBe(0);
  });
});

describe("a removed question", () => {
  it("fails without a note and passes with one", () => {
    const repo = makeRepo();
    branch(repo);
    repo.put(FIRST_QUIZ, read(repo, FIRST_QUIZ).replace("id: first-steps-5", "id: first-steps-five"));
    repo.update();
    repo.commit("rename a question");

    const failed = check(repo);
    repo.put(MIGRATIONS, "removed question first-steps-5: replaced by first-steps-five\n");

    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain("the question `first-steps-5` was published");
    expect(failed.stdout).toContain("`removed question first-steps-5: <reason>`");
    expect(check(repo).code).toBe(0);
  });
});

describe("the notes", () => {
  it("accept a leading '- ' or '* ', CRLF line endings, and a byte order mark", () => {
    const repo = makeRepo();
    branch(repo);
    renameWelcome(repo);
    repo.put(MIGRATIONS, "\uFEFF# Migrations\r\n\r\n- removed lesson 01-welcome: renamed\r\n");

    expect(check(repo).code).toBe(0);

    repo.put(MIGRATIONS, "\uFEFFremoved lesson 01-welcome: renamed on the first line\r\n");
    expect(check(repo).code).toBe(0);
  });

  it("need a reason", () => {
    const repo = makeRepo();
    branch(repo);
    renameWelcome(repo);

    for (const text of ["removed lesson 01-welcome:\n", "removed lesson 01-welcome:   \n", "removed lesson 01-welcome\n", "- removed  lesson 01-welcome: two spaces\n"]) {
      repo.put(MIGRATIONS, text);
      expect(check(repo).code, text).toBe(1);
    }
  });

  it("ignore prose, also prose that mentions a removal", () => {
    const repo = makeRepo();
    branch(repo);
    renameWelcome(repo);
    repo.put(MIGRATIONS, "We once said: removed lesson 01-welcome: gone\n  removed lesson 01-welcome: indented\n");

    expect(check(repo).code).toBe(1);
  });

  it("warn about a line that starts with 'removed ' and is not a note, and name the line", () => {
    const repo = makeRepo();
    branch(repo);
    repo.put(MIGRATIONS, "# Migrations\n\nremoved lesson setup\n- removed thing x: y\nremoved lesson ok-id: fine\n* removed question\n");
    repo.commit("notes only");

    const result = check(repo);

    expect(result.code).toBe(0);
    const prefix = `${slashes(repo.courses)}/sample-course/MIGRATIONS.md`;
    const warnings = result.stdout.split("\n").filter((line) => line.includes(": warning: "));
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:3: warning: this line starts with \`removed \` but is not a note`));
    expect(warnings[0]).toContain("`removed lesson setup`");
    expect(warnings[1]).toContain("MIGRATIONS.md:4: warning");
    expect(warnings[2]).toContain("MIGRATIONS.md:6: warning");
  });
});

describe("courses", () => {
  it("passes for a new course, which has no ids.json at the base", () => {
    const repo = makeRepo();
    branch(repo);
    cpSync(join(repo.courses, "sample-course"), join(repo.courses, "new-course"), { recursive: true });
    repo.put("courses/new-course/ids.json", null);
    repo.put("courses/new-course/course.yaml", read(repo, `${COURSE}/course.yaml`).replace("id: sample-course", "id: new-course"));
    repo.update();
    repo.commit("add a course");

    const result = check(repo);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("compared 1 published course(s)");
    expect(existsSync(join(repo.courses, "new-course", "ids.json"))).toBe(true);
  });

  it("fails for a published course whose folder is gone, and names the course", () => {
    const repo = makeRepo();
    branch(repo);
    repo.put(COURSE, null);
    repo.commit("remove the course");

    const result = check(repo);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`${slashes(repo.courses)}/sample-course: error: course \`sample-course\` was published`);
    expect(result.stdout).toContain("v1 does not remove courses");
  });

  it("also fails when no course is left in the courses folder", () => {
    const repo = makeRepo();
    branch(repo);
    repo.put(COURSE, null);
    writeFileSync(join(repo.courses, "README.md"), "# Courses\n");
    repo.commit("remove the course");

    const result = check(repo);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("no courses found in ");
    expect(result.stdout).toContain("course `sample-course` was published");
  });

  it("treats a base whose ids.json is the placeholder {} as publishing nothing", () => {
    const repo = makeRepo();
    repo.put(`${COURSE}/ids.json`, "{}\n");
    repo.commit("placeholder");
    branch(repo);
    renameWelcome(repo);

    expect(check(repo).code).toBe(0);
  });

  it("fails for a base whose ids.json is not JSON", () => {
    const repo = makeRepo();
    repo.put(`${COURSE}/ids.json`, "{");
    repo.commit("broken");
    branch(repo);
    repo.update();
    repo.commit("fixed");

    const result = check(repo);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("the ids.json of the base ");
  });

  it("does not compare a course whose own ids.json is wrong, which is reported by the first check", () => {
    const repo = makeRepo();
    branch(repo);
    renameWelcome(repo);
    repo.put(`${COURSE}/ids.json`, "{}\n");

    const result = check(repo);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("ids.json does not hold the IDs of the course");
    expect(result.stdout).not.toContain("was published");
  });
});

describe("the base commit", () => {
  it("is the merge base: IDs that main gained after the branch was made are not reported as removed", () => {
    const repo = makeRepo();
    branch(repo, "feature");
    repo.put(`${COURSE}/chapters/02-going-further/lessons/02-feature.mdx`, "---\ntitle: Feature\norder: 2\n---\n\n# Feature\n");
    repo.update();
    repo.commit("work on the branch");
    repo.git("checkout", "--quiet", "main");
    repo.put(`${COURSE}/chapters/02-going-further/lessons/02-from-main.mdx`, "---\ntitle: From main\norder: 2\n---\n\n# From main\n");
    repo.update();
    repo.commit("main moves on");
    repo.git("checkout", "--quiet", "feature");

    const result = check(repo);

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("02-from-main");
  });

  it("is compared with the last commit when --base names a commit by its hash", () => {
    const repo = makeRepo();
    const base = repo.git("rev-parse", "HEAD").trim();
    branch(repo);
    renameWelcome(repo);

    expect(check(repo, base).code).toBe(1);
    expect(check(repo, base.slice(0, 12)).code).toBe(1);
  });

  it("fails with a message for a ref that is not a commit", () => {
    const repo = makeRepo();

    const result = check(repo, "origin/main");

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^error: cannot compare with origin\/main: `origin\/main` is not a commit in this repository\./);
    expect(result.stdout).toBe("");
  });

  it("rejects a ref that starts with - and never passes it to git", () => {
    const repo = makeRepo();
    const marker = join(temporaryFolder(), "marker");

    for (const ref of ["-x", "--output=" + marker, "--upload-pack=touch " + marker]) {
      const result = check(repo, ref);
      expect(result.code, ref).toBe(2);
      expect(result.stderr, ref).toContain("starts with `-`");
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("is skipped, with a notice, for a ref of only zeros (the first push of main)", () => {
    const repo = makeRepo();

    const result = check(repo, "0000000000000000000000000000000000000000");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("only zeros");
    expect(result.stdout).toContain("skipped");
  });

  it("still runs the first check when the comparison is skipped", () => {
    const repo = makeRepo();
    repo.put(`${COURSE}/ids.json`, "{}\n");

    const result = check(repo, "0000000000000000000000000000000000000000");

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("ids.json does not hold the IDs of the course");
  });

  it("fails outside a git repository, with git's message", () => {
    const result = runIds("check", [coursesFolder(), "--base", "main"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^error: cannot compare with main: /);
  });

  it("works when the courses folder is the top of the repository", () => {
    const repo = makeRepo();
    git(repo.root, "mv", "courses/sample-course", "sample-course");
    repo.put("courses", null);
    repo.commit("move the course to the top");
    branch(repo);
    const welcome = "sample-course/chapters/01-first-steps/lessons/01-welcome.mdx";
    repo.put(welcome, null);
    repo.put("sample-course/chapters/01-first-steps/lessons/01-hello.mdx", "---\ntitle: Hello\norder: 1\n---\n\n# Hello\n");
    repo.put("sample-course/chapters/01-first-steps/quiz.yaml", read(repo, "sample-course/chapters/01-first-steps/quiz.yaml").replaceAll("lesson: 01-welcome", "lesson: 01-hello"));
    const result = runIds("update", [repo.root]);
    expect(result.code).toBe(0);
    repo.commit("rename");
    git(repo.root, "branch", "--quiet", "-f", "top", "main");

    const failed = runIds("check", [repo.root, "--base", "top"]);

    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain("the lesson `01-welcome` was published");
  });
});

describe("a shallow clone", () => {
  function shallowClone(depth: number): string {
    const repo = makeRepo();
    repo.put(`${COURSE}/notes.txt`, "second commit");
    repo.commit("second");
    repo.put(`${COURSE}/notes.txt`, "third commit");
    repo.commit("third");
    const clone = join(temporaryFolder(), "clone");
    git(temporaryFolder(), "clone", "--quiet", `--depth=${depth}`, `file://${slashes(repo.root)}`, clone);
    return clone;
  }

  it("fails with a message that says to fetch more history when the base is not there", () => {
    const clone = shallowClone(1);

    const result = runIds("check", [join(clone, "courses"), "--base", "HEAD~1"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is not a commit in this repository");
    expect(result.stderr).toContain("shallow clone");
    expect(result.stderr).toContain("fetch-depth: 0");
    expect(result.stdout).not.toContain("ids ok");
  });

  it("fails when the merge base is the cut-off commit, whose history is unknown", () => {
    const clone = shallowClone(1);

    const result = runIds("check", [join(clone, "courses"), "--base", "HEAD"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is cut off");
    expect(result.stderr).toContain("git fetch --unshallow");
  });

  it("works once the history is complete", () => {
    const clone = shallowClone(1);
    git(clone, "fetch", "--quiet", "--unshallow");

    const result = runIds("check", [join(clone, "courses"), "--base", "HEAD~1"]);

    expect(result.code).toBe(0);
  });
});
