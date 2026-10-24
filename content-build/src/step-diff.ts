// The data of the step viewer: every file of every step, its status against the previous step, and the lines changed.

import { diffArrays } from "diff";
import type { StepFiles } from "./code-steps.ts";
import { compareText, splitLines } from "./text.ts";

export type FileStatus = "added" | "modified" | "unchanged" | "deleted";

/** One file in a step, with the keys in the order they are written. */
export type StepFileJson = {
  path: string;
  status: FileStatus;
  /** The normalized text; "" for a deleted file. */
  content: string;
  /** Line numbers (from 1) in `content` that are new or changed, ascending; [] for unchanged and deleted files. */
  changed_lines: number[];
};

export type StepJson = {
  step: number;
  files: StepFileJson[];
};

/**
 * The most edits (added plus removed lines) the line comparison looks for in one file. A file that
 * differs by more is shown as changed in every line, so a huge rewrite cannot make the build slow.
 */
export const MAX_EDIT_LENGTH = 10_000;

/** The numbers (from 1) of the lines of `next` that are not in `previous`, comparing whole lines with their line ending. */
function changedLines(previous: string, next: string, maxEditLength: number): number[] {
  const newLines = splitLines(next);
  const changes = diffArrays(splitLines(previous), newLines, { maxEditLength });
  if (changes === undefined) return newLines.map((_, index) => index + 1);
  const changed: number[] = [];
  let line = 0;
  for (const change of changes) {
    if (change.removed) continue;
    for (let i = 0; i < change.value.length; i++) {
      line++;
      if (change.added) changed.push(line);
    }
  }
  return changed;
}

/**
 * The steps of a chapter as data. `steps` hold normalized text in memory; nothing is read from disk.
 * Step 1 lists all its files as added. A later step lists its own files and the files of the previous
 * step that are gone (deleted). A renamed file is a deleted file and an added file. Files are sorted
 * by path and steps by number, so the result does not depend on the order of the input.
 */
export function diffSteps(steps: readonly StepFiles[], maxEditLength: number = MAX_EDIT_LENGTH): StepJson[] {
  const result: StepJson[] = [];
  let previous: ReadonlyMap<string, string> | undefined;
  for (const { step, files } of [...steps].sort((a, b) => a.step - b.step)) {
    const entries: StepFileJson[] = [];
    for (const [path, content] of files) {
      const before = previous?.get(path);
      if (before === undefined) {
        entries.push({ path, status: "added", content, changed_lines: splitLines(content).map((_, index) => index + 1) });
      } else if (before === content) {
        entries.push({ path, status: "unchanged", content, changed_lines: [] });
      } else {
        entries.push({ path, status: "modified", content, changed_lines: changedLines(before, content, maxEditLength) });
      }
    }
    for (const path of previous?.keys() ?? []) {
      if (!files.has(path)) entries.push({ path, status: "deleted", content: "", changed_lines: [] });
    }
    result.push({ step, files: entries.sort((a, b) => compareText(a.path, b.path)) });
    previous = files;
  }
  return result;
}
