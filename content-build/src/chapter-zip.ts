// The ZIP of a chapter's final project. The bytes depend only on the chapter folder name and the files.

import { createHash } from "node:crypto";
import JSZip from "jszip";
import { compareText } from "./text.ts";

/** 1980-01-01 00:00:00, the earliest time a ZIP can hold. JSZip writes the UTC fields of the date, so the time zone cannot matter. */
const ZIP_DATE = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));
/** `-rw-r--r--`: a regular file, mode 0644. */
const FILE_MODE = 0o100644;

export type ChapterZip = {
  /** `<chapter_id>-<first 16 hex digits of sha256>.zip`. */
  file: string;
  sha256: string;
  bytes: Uint8Array;
};

/**
 * A ZIP with the given files (path to normalized text) under one top-level folder named `chapterId`:
 * `03-tools/server.py`. Entries are sorted by path, with no folder entries, the same time and mode
 * on every entry, one compression setting, and no comment.
 */
export async function buildChapterZip(chapterId: string, files: ReadonlyMap<string, string>): Promise<ChapterZip> {
  const zip = new JSZip();
  for (const path of [...files.keys()].sort(compareText)) {
    zip.file(`${chapterId}/${path}`, new TextEncoder().encode(files.get(path)), {
      date: ZIP_DATE,
      unixPermissions: FILE_MODE,
      createFolders: false,
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
  }
  const bytes = await zip.generateAsync({
    type: "uint8array",
    platform: "UNIX",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { file: `${chapterId}-${sha256.slice(0, 16)}.zip`, sha256, bytes };
}
