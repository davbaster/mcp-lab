// A replacement for "node:fs" that records every path the build asks the file system about, for tests that
// prove what is not touched. The real functions still run.

import type * as Fs from "node:fs";

export type Operation = "read" | "write";

/** `calls` gets `read <path>` or `write <path>` for each call. */
export function recordingFs(actual: typeof Fs, calls: string[]): typeof Fs {
  const record = (name: string, kind: Operation) => {
    const real = (actual as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
    if (real === undefined) throw new Error(`node:fs has no ${name}`);
    return (...args: unknown[]) => {
      calls.push(`${kind} ${String(args[0])}`);
      return real(...args);
    };
  };
  const wrapped = {
    ...actual,
    readFileSync: record("readFileSync", "read"),
    statSync: record("statSync", "read"),
    lstatSync: record("lstatSync", "read"),
    readdirSync: record("readdirSync", "read"),
    openSync: record("openSync", "read"),
    existsSync: record("existsSync", "read"),
    accessSync: record("accessSync", "read"),
    realpathSync: record("realpathSync", "read"),
    writeFileSync: record("writeFileSync", "write"),
    mkdirSync: record("mkdirSync", "write"),
    rmSync: record("rmSync", "write"),
    renameSync: record("renameSync", "write"),
    cpSync: record("cpSync", "write"),
    appendFileSync: record("appendFileSync", "write"),
  } as unknown as typeof Fs;
  return { ...wrapped, default: wrapped } as typeof Fs;
}
