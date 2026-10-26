/**
 * The lines of a file, the way the content build counts them (content-build/README.md, "Text and
 * diffs"): lines are separated by `\n` only (a lone `\r` stays in its line), a final newline adds
 * no extra last line, a file with no `\n` is one line, and an empty file has no lines.
 */
export interface CodeLine {
  /** The text of the line, without its line break. */
  text: string;
  /** `"\n"`, or `""` for the last line of a file that does not end with a newline. */
  end: "\n" | "";
}

export function splitLines(content: string): CodeLine[] {
  if (content === "") return [];
  const parts = content.split("\n");
  // A final newline leaves an empty piece after it, which is not a line.
  const finalNewline = parts[parts.length - 1] === "";
  if (finalNewline) parts.pop();
  const last = parts.length - 1;
  return parts.map((text, index) => ({ text, end: index < last || finalNewline ? "\n" : "" }));
}
