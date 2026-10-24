// The note format of MIGRATIONS.md.

import { describe, expect, it } from "vitest";
import { parseMigrations } from "../src/migrations.ts";

const notes = (text: string) => parseMigrations(text, "MIGRATIONS.md");

describe("parseMigrations", () => {
  it("reads removed <kind> <id>: <reason> for the three kinds", () => {
    const { removed, warnings } = notes("removed chapter 03-tools: cut\nremoved lesson intro: merged\nremoved question q-1: replaced\n");

    expect([...removed]).toEqual(["chapter 03-tools", "lesson intro", "question q-1"]);
    expect(warnings).toEqual([]);
  });

  it("allows a leading '- ' or '* ', CRLF, a byte order mark, and trailing spaces", () => {
    const { removed, warnings } = notes("﻿# Migrations\r\n- removed lesson a: x\r\n* removed lesson b: y   \r\n");

    expect([...removed]).toEqual(["lesson a", "lesson b"]);
    expect(warnings).toEqual([]);
  });

  it("ignores prose, including text that only contains a note", () => {
    const { removed, warnings } = notes("# Migrations\n\nNo IDs were removed. We said removed lesson a: x once.\n  removed lesson b: indented\n");

    expect(removed.size).toBe(0);
    expect(warnings).toEqual([]);
  });

  it.each([
    ["no reason", "removed lesson a:"],
    ["a blank reason", "removed lesson a:    "],
    ["no colon", "removed lesson a"],
    ["a kind that does not exist", "removed page a: x"],
    ["a kind in capitals", "removed Lesson a: x"],
    ["an ID with capitals", "removed lesson A: x"],
    ["two spaces", "removed  lesson a: x"],
    ["only a kind", "removed lesson"],
  ])("warns about %s, with the line number, and does not count it", (_name, line) => {
    const { removed, warnings } = notes(`Prose.\n${line}\n`);

    expect(removed.size).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ severity: "warning", file: "MIGRATIONS.md", line: 2 });
    expect(warnings[0]?.message).toContain("starts with `removed ` but is not a note");
    expect(warnings[0]?.message).toContain("removed <chapter|lesson|question> <id>: <reason>");
  });

  it("shortens a long line in the warning", () => {
    const { warnings } = notes(`removed lesson ${"a".repeat(200)}`);

    expect(warnings[0]?.message.length).toBeLessThan(260);
  });

  it("returns nothing for an empty file", () => {
    expect(notes("")).toEqual({ removed: new Set(), warnings: [] });
  });
});
