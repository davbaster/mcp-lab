// The few git commands that the ID check needs. They run without a shell, with the arguments as an array.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** A git command failed, or git is missing. The message is for the person running the command. */
export class GitError extends Error {}

/** The ref starts with `-`, so git could take it for an option. */
export class RefError extends Error {}

/** git must find the repository from the folder, not from the environment of whoever started it. */
const LOCATION_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES"];

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of LOCATION_VARIABLES) delete env[name];
  return env;
}

function run(cwd: string, args: readonly string[]): Buffer {
  try {
    return execFileSync("git", args, { cwd, env: gitEnv(), stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
  } catch (error) {
    const failure = error as { code?: string; stderr?: Buffer; status?: number | null };
    if (failure.code === "ENOENT") throw new GitError("git is not installed or is not on PATH");
    const stderr = failure.stderr?.toString("utf8").trim() ?? "";
    throw new GitError(stderr === "" ? `git ${args[0] ?? ""} failed` : stderr.split(/\r?\n/)[0] ?? "git failed");
  }
}

function text(cwd: string, args: readonly string[]): string {
  return run(cwd, args).toString("utf8").trim();
}

/** True when git succeeds, false when it exits with an error (for a question like "is this a commit?"). */
function succeeds(cwd: string, args: readonly string[]): string | undefined {
  try {
    return text(cwd, args);
  } catch (error) {
    if (error instanceof GitError && error.message === "git is not installed or is not on PATH") throw error;
    return undefined;
  }
}

const FETCH_MORE = "fetch more history (in GitHub Actions, give actions/checkout `fetch-depth: 0`; locally, run `git fetch --unshallow`)";

/**
 * The commit to compare with: `git merge-base <ref> HEAD`, found from `cwd`. Returns `"skip"` for a ref of only zeros
 * (the base of the first push of a branch). Throws a `RefError` for a ref that starts with `-`, and a `GitError`
 * for a ref that is not a commit, for no common ancestor, and for a shallow clone that lacks the base.
 */
export function mergeBase(cwd: string, ref: string): { commit: string } | "skip" {
  if (ref.startsWith("-")) throw new RefError(`the ref \`${ref}\` starts with \`-\`, which git could take for an option`);
  if (/^0+$/.test(ref)) return "skip";
  const shallow = succeeds(cwd, ["rev-parse", "--is-shallow-repository"]) === "true";
  const lacks = shallow ? ` This is a shallow clone, so the commit may be missing: ${FETCH_MORE}.` : "";
  const commit = succeeds(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (commit === undefined || commit === "") throw new GitError(`\`${ref}\` is not a commit in this repository.${lacks}`);
  const base = succeeds(cwd, ["merge-base", commit, "HEAD"]);
  if (base === undefined || base === "") {
    throw new GitError(shallow ? `no common ancestor of \`${ref}\` and HEAD was found.${lacks}` : `\`${ref}\` and HEAD have no common ancestor`);
  }
  if (shallow && isShallowBoundary(cwd, base)) {
    throw new GitError(`the history of the base commit ${base.slice(0, 12)} is cut off, so the real merge base may be older.${lacks}`);
  }
  return { commit: base };
}

function isShallowBoundary(cwd: string, commit: string): boolean {
  const file = succeeds(cwd, ["rev-parse", "--git-path", "shallow"]);
  if (file === undefined) return true;
  try {
    return readFileSync(resolve(cwd, file), "utf8").split(/\r?\n/).includes(commit);
  } catch {
    return false;
  }
}

/** The path of `cwd` inside the repository with a final `/`, or `""` at the top: `courses/`. */
export function pathInRepository(cwd: string): string {
  const prefix = text(cwd, ["rev-parse", "--show-prefix"]);
  return prefix;
}

export type TreeEntry = { type: "blob" | "tree" | "other"; /** True for a regular file, not a link. */ regular: boolean; sha: string; name: string };

/** The entries of a folder in a commit (`folder` is `""` for the top, or `courses/`). Empty when the folder is not in the commit. */
export function listTree(cwd: string, commit: string, folder: string): TreeEntry[] {
  const out = run(cwd, ["ls-tree", "-z", "--full-tree", commit, ...(folder === "" ? [] : [folder])]).toString("utf8");
  const entries: TreeEntry[] = [];
  for (const record of out.split("\0")) {
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]*)$/.exec(record);
    if (match?.[2] === undefined || match[3] === undefined || match[4] === undefined) continue;
    const name = match[4].slice(folder.length);
    const type = match[2] === "blob" ? "blob" : match[2] === "tree" ? "tree" : "other";
    entries.push({ type, regular: match[1] === "100644" || match[1] === "100755", sha: match[3], name });
  }
  return entries;
}

/** The content of a blob. */
export function readBlob(cwd: string, sha: string): string {
  return run(cwd, ["cat-file", "blob", sha]).toString("utf8");
}
