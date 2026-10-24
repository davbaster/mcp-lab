// The rule for paths that Windows cannot extract works on lists of path strings, so these tests run the same everywhere.

import { describe, expect, it } from "vitest";
import { windowsPathProblems } from "../src/windows-paths.ts";

const paths = (...list: string[]) => windowsPathProblems(list, 100).map((problem) => problem.path);

describe("names with characters Windows does not allow", () => {
  it.each(["<", ">", ":", '"', "\\", "|", "?", "*"])("rejects %s in a name", (character) => {
    expect(paths(`src/a${character}b.py`)).toEqual([`src/a${character}b.py`]);
  });

  it.each(["\u0000", "\u0001", "\t", "\n", "\u001f", "\u007f", "\u0085"])("rejects the control character %j in a name", (character) => {
    expect(paths(`a${character}b.py`)).toEqual([`a${character}b.py`]);
  });

  it("names the folder, once, when the bad name is a folder", () => {
    expect(paths("src/a:b/x.py", "src/a:b/y.py", "src/a:b/deeper/z.py")).toEqual(["src/a:b"]);
  });

  it("accepts the usual names", () => {
    expect(paths("main.py", "src/util_2.py", "a-b/c d/e.f.g", ".env.example", "ünï/日本語.txt", "a b.py", "...x")).toEqual([]);
  });
});

describe("names ending in a space or a dot", () => {
  it.each(["name.", "name ", "name..", "name. ", "folder./file.py", "folder /file.py"])("rejects %j", (path) => {
    expect(paths(path)).toHaveLength(1);
  });

  it("accepts a dot or a space inside a name, and a name that starts with them", () => {
    expect(paths(".hidden", " lead", "a.b", "a b")).toEqual([]);
  });
});

describe("Windows device names", () => {
  const devices = ["CON", "PRN", "AUX", "NUL", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => [`COM${n}`, `LPT${n}`])];

  it.each(devices)("rejects %s with or without an extension, in any case", (device) => {
    expect(paths(device)).toEqual([device]);
    expect(paths(`${device.toLowerCase()}.txt`)).toEqual([`${device.toLowerCase()}.txt`]);
    expect(paths(`src/${device[0]}${device.slice(1).toLowerCase()}.tar.gz`)).toHaveLength(1);
  });

  it("rejects a device name used as a folder", () => {
    expect(paths("aux/main.py")).toEqual(["aux"]);
  });

  it.each(["COM0", "COM10", "LPT0", "CONSOLE", "NULL", "AUXILIARY.py", "com", "lpt", "x.con", "ccon", "COM1x"])("accepts %s", (name) => {
    expect(paths(name)).toEqual([]);
  });
});

describe("names that differ only in letter case", () => {
  it("names both files", () => {
    expect(paths("Util.py", "util.py")).toEqual(["Util.py", "util.py"]);
    expect(windowsPathProblems(["Util.py", "util.py"], 100).map((problem) => problem.message)).toEqual([
      "this path cannot be extracted on Windows: `util.py` in the same folder differs only in letter case, and Windows and macOS keep only one of them",
      "this path cannot be extracted on Windows: `Util.py` in the same folder differs only in letter case, and Windows and macOS keep only one of them",
    ]);
  });

  it("names folders that differ only in case, not the files inside them", () => {
    expect(paths("Src/a.py", "src/b.py")).toEqual(["Src", "src"]);
  });

  it("names every name of a group of three", () => {
    expect(paths("a.py", "A.py", "a.PY", "A.PY")).toEqual(["A.PY", "A.py", "a.PY", "a.py"]);
  });

  it("accepts the same name in different folders and names that differ in more than case", () => {
    expect(paths("a/x.py", "b/X.py", "x.py", "xx.py", "a/b", "A-b")).toEqual([]);
  });

  it("does not depend on the order of the list", () => {
    expect(windowsPathProblems(["util.py", "Util.py", "z.py"], 100)).toEqual(windowsPathProblems(["z.py", "Util.py", "util.py"], 100));
  });
});

describe("long paths", () => {
  const path = (length: number) => "a".repeat(length - 3) + ".py";

  it("accepts a path of 100 characters and rejects 101", () => {
    expect(paths(path(100))).toEqual([]);
    expect(paths(path(101))).toEqual([path(101)]);
    expect(windowsPathProblems([path(101)], 100)[0]?.message).toBe(
      "this path cannot be extracted on Windows: it is 101 characters long and the most allowed is 100",
    );
  });

  it("counts the whole path inside the step, with its folders and slashes", () => {
    const folder = "d".repeat(50);

    expect(paths(`${folder}/${"f".repeat(49)}`)).toEqual([]);
    expect(paths(`${folder}/${"f".repeat(50)}`)).toEqual([`${folder}/${"f".repeat(50)}`]);
  });

  it("names the shortest folder that is already too long, once", () => {
    const folder = "d".repeat(101);

    expect(paths(`${folder}/a.py`, `${folder}/b.py`)).toEqual([folder]);
  });

  it("takes the limit as an argument", () => {
    expect(windowsPathProblems(["abcd"], 3)).toHaveLength(1);
    expect(windowsPathProblems(["abc"], 3)).toEqual([]);
  });
});

describe("several problems", () => {
  it("lists every bad path, sorted by path, with one reason for each name", () => {
    const problems = windowsPathProblems(["z.py", "con.", "b?.py"], 100);

    expect(problems.map((problem) => problem.path)).toEqual(["b?.py", "con."]);
  });

  it("lists a name that is bad and too long under the path where each starts", () => {
    const long = "d".repeat(101);

    expect(paths(`${long}?`)).toEqual([`${long}?`, `${long}?`]);
  });

  it("returns nothing for an empty list", () => {
    expect(windowsPathProblems([], 100)).toEqual([]);
  });
});
