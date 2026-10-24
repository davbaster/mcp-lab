// The notes in a course's MIGRATIONS.md that say why a published ID was removed.

import type { Problem } from "./problem.ts";
import { KINDS } from "./ids.ts";
import type { Kind } from "./ids.ts";

export type MigrationNotes = {
  /** The notes, as `<kind> <id>`. */
  removed: Set<string>;
  /** A line that starts with `removed ` but is not a note. */
  warnings: Problem[];
};

const NOTE = new RegExp(`^(?:[-*] )?removed (${KINDS.join("|")}) ([a-z0-9-]+):[ \\t]+(\\S.*)$`);
const NOTE_START = /^(?:[-*] )?removed /;

/** The key of a note in `MigrationNotes.removed`. */
export function noteKey(kind: Kind, id: string): string {
  return `${kind} ${id}`;
}

/**
 * Reads the text of MIGRATIONS.md. A note is a line `removed <kind> <id>: <reason>` (`<kind>` is `chapter`, `lesson`,
 * or `question`; `<reason>` is not empty), with an optional `- ` or `* ` in front. Any other line is prose and is
 * ignored, except a line that starts with `removed `, which is a warning. `file` is the path in the warnings.
 */
export function parseMigrations(text: string, file: string): MigrationNotes {
  const removed = new Set<string>();
  const warnings: Problem[] = [];
  const lines = (text.startsWith("\uFEFF") ? text.slice(1) : text).split(/\r\n|\n|\r/);
  lines.forEach((raw, index) => {
    const line = raw.trimEnd();
    const match = NOTE.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      removed.add(noteKey(match[1] as Kind, match[2]));
    } else if (NOTE_START.test(line)) {
      const shown = line.length > 60 ? `${line.slice(0, 57)}...` : line;
      warnings.push({
        severity: "warning",
        file,
        line: index + 1,
        message: `this line starts with \`removed \` but is not a note, so it is ignored: \`${shown}\`; write \`removed <chapter|lesson|question> <id>: <reason>\``,
      });
    }
  });
  return { removed, warnings };
}
