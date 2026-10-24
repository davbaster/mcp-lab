// A temporary git repository for the ID check: no network, a fixed author and fixed dates, and no use of the user's git settings.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VALID_COURSE, temporaryFolder } from "./helpers.ts";
import { runIds } from "./build-support.ts";

export function git(cwd: string, ...args: string[]): string {
  const config = join(temporaryFolder(), "gitconfig");
  writeFileSync(config, "");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test Author",
    GIT_AUTHOR_EMAIL: "author@example.invalid",
    GIT_COMMITTER_NAME: "Test Author",
    GIT_COMMITTER_EMAIL: "author@example.invalid",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[name];
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-c", "protocol.file.allow=always", ...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export type Repo = {
  /** The top of the repository. */
  root: string;
  /** `<root>/courses`, the courses folder. */
  courses: string;
  /** Writes (or, with null, removes) a file or folder inside the repository. */
  put(path: string, content: string | null): void;
  /** Regenerates the ids.json of every course. */
  update(): void;
  /** Commits everything. */
  commit(message: string): string;
  git(...args: string[]): string;
};

/** A repository whose `main` has one commit: `courses/sample-course` (the valid fixture, with its real ids.json). */
export function makeRepo(): Repo {
  const root = join(temporaryFolder(), "repo");
  mkdirSync(join(root, "courses"), { recursive: true });
  git(root, "init", "--quiet");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  cpSync(VALID_COURSE, join(root, "courses", "sample-course"), { recursive: true });
  const courses = join(root, "courses");
  const repo: Repo = {
    root,
    courses,
    put(path, content) {
      const target = join(root, ...path.split("/"));
      if (content === null) {
        rmSync(target, { recursive: true, force: true });
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
    },
    update() {
      const result = runIds("update", [courses]);
      if (result.code !== 0) throw new Error(`ids:update failed: ${result.stdout}${result.stderr}`);
    },
    commit(message) {
      git(root, "add", "-A");
      git(root, "commit", "--quiet", "-m", message);
      return git(root, "rev-parse", "HEAD").trim();
    },
    git: (...args) => git(root, ...args),
  };
  repo.update();
  repo.commit("base");
  return repo;
}

export const read = (repo: Repo, path: string) => readFileSync(join(repo.root, ...path.split("/")), "utf8");
