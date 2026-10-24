// Which paths cannot be extracted on Windows. It works on path strings only, so it gives the same answer on every platform.

import { compareText } from "./text.ts";

export type PathProblem = {
  /** The path of the file or folder that has the problem, with `/` separators, relative to the step. */
  path: string;
  message: string;
};

const BAD_CHARACTERS = /[<>:"\\|?*\p{Cc}]/u;
const DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

function badName(name: string): string | undefined {
  if (BAD_CHARACTERS.test(name)) {
    return 'the name has a character that Windows does not allow in file names (one of < > : " \\ | ? * or a control character)';
  }
  if (name.endsWith(" ") || name.endsWith(".")) return "the name ends with a space or a dot, which Windows removes";
  // A device name is reserved with any extension: `con`, `NUL.txt`, `com1.tar.gz`.
  if (DEVICE_NAME.test(name.split(".")[0] ?? "")) {
    return "the name is a Windows device name (CON, PRN, AUX, NUL, COM1 to COM9, LPT1 to LPT9), alone or with an extension";
  }
  return undefined;
}

/**
 * Checks file paths (`/` between names, relative to the step) against what Windows can extract: no
 * `< > : " \ | ? *` or control character in a name, no name ending in a space or a dot, no device name,
 * no two names in one folder that differ only in letter case, and no path longer than `maxLength`.
 * A folder is named once, whatever the number of files under it. Each problem names the shortest path
 * that has it. The result is sorted, so it does not depend on the order of `paths`.
 */
export function windowsPathProblems(paths: readonly string[], maxLength: number): PathProblem[] {
  const problems = new Map<string, PathProblem>();
  const add = (path: string, message: string) => problems.set(`${path}\u0000${message}`, { path, message });
  const children = new Map<string, Set<string>>();

  for (const path of paths) {
    let prefix = "";
    let tooLongSeen = false;
    for (const name of path.split("/")) {
      const parent = prefix;
      prefix = parent === "" ? name : `${parent}/${name}`;
      const siblings = children.get(parent) ?? new Set<string>();
      siblings.add(name);
      children.set(parent, siblings);
      const reason = badName(name);
      if (reason !== undefined) add(prefix, `this path cannot be extracted on Windows: ${reason}`);
      if (!tooLongSeen && prefix.length > maxLength) {
        tooLongSeen = true;
        add(prefix, `this path cannot be extracted on Windows: it is ${prefix.length} characters long and the most allowed is ${maxLength}`);
      }
    }
  }

  for (const [parent, names] of children) {
    const groups = new Map<string, string[]>();
    for (const name of names) {
      const key = name.toLowerCase();
      groups.set(key, [...(groups.get(key) ?? []), name]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group.sort(compareText);
      for (const name of group) {
        const other = group[0] === name ? group[1] : group[0];
        const path = parent === "" ? name : `${parent}/${name}`;
        add(path, `this path cannot be extracted on Windows: \`${other}\` in the same folder differs only in letter case, and Windows and macOS keep only one of them`);
      }
    }
  }

  return [...problems.values()].sort((a, b) => compareText(a.path, b.path) || compareText(a.message, b.message));
}
