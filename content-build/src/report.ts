// Collecting problems, and warning about files that are not part of the format.

import type { Kind } from "./folder.ts";
import type { Problem, Severity } from "./problem.ts";

export type Report = {
  problems: Problem[];
  error(file: string, message: string, line?: number, column?: number): void;
  warning(file: string, message: string, line?: number, column?: number): void;
};

export function makeReport(): Report {
  const problems: Problem[] = [];
  const add = (severity: Severity) => (file: string, message: string, line?: number, column?: number) => {
    if (line === undefined) problems.push({ severity, file, message });
    else problems.push(column === undefined ? { severity, file, line, message } : { severity, file, line, column, message });
  };
  return { problems, error: add("error"), warning: add("warning") };
}

export type EntrySpec = Record<string, { kind: Exclude<Kind, "other">; required?: boolean }>;

/**
 * Warns about every entry of a folder that the format does not name, and about a named entry that is
 * the wrong kind (a file called `assets`). A required entry of the wrong kind is reported as missing
 * by the caller, so it is skipped here. `where` names the folder in the message, such as "course".
 */
export function checkKnownEntries(
  report: Report,
  prefix: string,
  found: Map<string, Kind>,
  spec: EntrySpec,
  where: string,
) {
  const path = (name: string) => (prefix === "" ? name : `${prefix}/${name}`);
  for (const [name, kind] of found) {
    const expected = Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (expected === undefined) {
      const what = kind === "directory" ? "folder" : "file";
      report.warning(path(name), `this ${what} is not part of the ${where} format and is ignored`);
    } else if (kind !== expected.kind && !expected.required) {
      const should = expected.kind === "directory" ? "a folder" : "a file";
      report.warning(path(name), `\`${name}\` should be ${should} and is ignored`);
    }
  }
}
