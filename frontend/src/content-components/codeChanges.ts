/**
 * What step mode (#22) shows about the changes between code steps: which lines are marked, the
 * counts line above the tabs, the label of a file's tab, and which file to select after a step
 * change. Paths are only ever compared with `===` or kept as values, never used as object keys.
 */
import type { CodeFile } from "./codeData";

export const FIRST_STEP_NOTE = "First step: every file is new.";
export const NO_CHANGES_NOTE = "No changes in this step";
export const FILE_REMOVED_NOTE = "This file was removed in this step";
export const LINES_REMOVED_NOTE = "Lines were removed from this file in this step.";

/** The label on a file's tab, from its status. `unchanged` has none. */
export function fileLabel(status: CodeFile["status"]): "New" | "Changed" | "Deleted" | null {
  switch (status) {
    case "added":
      return "New";
    case "modified":
      return "Changed";
    case "deleted":
      return "Deleted";
    default:
      return null;
  }
}

/**
 * The counts of a step's files for the changes line: `modified` as "changed", `added` as "added"
 * and `deleted` as "deleted", in that order. A count of 0 is left out, and the first part that
 * is left carries the word "file" or "files". Null when no file counts.
 */
export function changeSummary(files: readonly CodeFile[]): string | null {
  const count = (status: CodeFile["status"]) => files.filter((file) => file.status === status).length;
  const parts: [number, string][] = [
    [count("modified"), "changed"],
    [count("added"), "added"],
    [count("deleted"), "deleted"],
  ];
  const present = parts.filter(([number]) => number > 0);
  if (present.length === 0) return null;
  return present.map(([number, word], index) => (index === 0 ? `${number} ${number === 1 ? "file" : "files"} ${word}` : `${number} ${word}`)).join(", ");
}

/**
 * The line numbers to mark in a file: none on the first step (the data lists every line there),
 * none for a file that is `unchanged` or `deleted`, and otherwise the numbers of `changed_lines`
 * that are whole, inside the file and larger than the one kept before them. A number that is too
 * large, repeated or out of order is ignored.
 */
export function markedLines(file: CodeFile, lineCount: number, firstStep: boolean): ReadonlySet<number> {
  const marked = new Set<number>();
  if (firstStep || (file.status !== "added" && file.status !== "modified")) return marked;
  let previous = 0;
  for (const line of file.changedLines) {
    if (!Number.isInteger(line) || line <= previous || line > lineCount) continue;
    marked.add(line);
    previous = line;
  }
  return marked;
}

/**
 * The path of the file to select in `files`: `preferred` if it is there and not deleted, else the
 * first `added` or `modified` file, else the first file that is not deleted, else the first file.
 * Null for a step without files.
 */
export function chooseFile(files: readonly CodeFile[], preferred: string | null): string | null {
  if (preferred !== null && files.some((file) => file.path === preferred && file.status !== "deleted")) return preferred;
  const found =
    files.find((file) => file.status === "added" || file.status === "modified") ?? files.find((file) => file.status !== "deleted") ?? files[0];
  return found === undefined ? null : found.path;
}
