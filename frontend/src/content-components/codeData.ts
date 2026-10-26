/**
 * The chapter's code for one lesson view (#21, #22). The lesson page gives `LessonContent` the
 * course and chapter IDs, `CodeDataProvider` asks for the code once, and every `CodeSteps` in the
 * lesson reads the same answer from this context. The answer lives only in the memory of the
 * mounted lesson: the response is `private, no-store` and depends on who is signed in, so it is
 * never kept in a module-level variable or in browser storage.
 */
import { createContext, useContext } from "react";
import { isRecord } from "./tree";

export type CodeFileStatus = "added" | "modified" | "deleted" | "unchanged";

export interface CodeFile {
  path: string;
  status: CodeFileStatus;
  content: string;
  /** Line numbers of the new version, from 1. Step mode (#22) marks these lines on every step after the first. */
  changedLines: number[];
}

export interface CodeStep {
  step: number;
  files: CodeFile[];
}

export interface ChapterCode {
  zip: { url: string; fileName: string };
  steps: CodeStep[];
}

export type CodeState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; code: ChapterCode };

export interface CodeSource {
  state: CodeState;
  /** Asks for the code if nobody has yet. Safe to call from every viewer, and twice under StrictMode. */
  ensure: () => void;
  /** Asks again after a failure. The one request refreshes every viewer. */
  retry: () => void;
}

/** Null where the lesson's course and chapter are not known: a viewer cannot be shown there. */
export const CodeSourceContext = createContext<CodeSource | null>(null);

export function useCodeSource(): CodeSource | null {
  return useContext(CodeSourceContext);
}

const STATUSES: readonly string[] = ["added", "modified", "deleted", "unchanged"];

function readFile(value: unknown): CodeFile | null {
  if (!isRecord(value)) return null;
  const { path, status, content, changed_lines } = value;
  if (typeof path !== "string" || typeof content !== "string") return null;
  if (typeof status !== "string" || !STATUSES.includes(status)) return null;
  if (!Array.isArray(changed_lines) || !changed_lines.every((line) => Number.isInteger(line))) return null;
  return { path, status: status as CodeFileStatus, content, changedLines: changed_lines as number[] };
}

function readStep(value: unknown): CodeStep | null {
  if (!isRecord(value) || !Number.isInteger(value.step) || !Array.isArray(value.files)) return null;
  const files = value.files.map(readFile);
  if (files.some((file) => file === null)) return null;
  return { step: value.step as number, files: files as CodeFile[] };
}

/** The answer of `getChapterCode`, checked at run time (the API types are not trusted); null if it is not one. */
export function readChapterCode(data: unknown): ChapterCode | null {
  if (!isRecord(data) || !isRecord(data.zip) || !Array.isArray(data.steps)) return null;
  const { url, file_name } = data.zip;
  if (typeof url !== "string" || typeof file_name !== "string") return null;
  const steps = data.steps.map(readStep);
  if (steps.some((step) => step === null)) return null;
  return { zip: { url, fileName: file_name }, steps: steps as CodeStep[] };
}
