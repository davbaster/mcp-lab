// The compiled form of a lesson: a tree of plain data (see schemas/lesson-tree.schema.json).

import type { ValidateFunction } from "ajv";
import lessonTreeSchema from "../schemas/lesson-tree.schema.json" with { type: "json" };
import { newAjv } from "./schema.ts";

export type TextNode = { type: "text"; value: string };
export type InlineCodeNode = { type: "inlineCode"; value: string };
export type BreakNode = { type: "break" };
export type EmphasisNode = { type: "emphasis"; children: PhrasingNode[] };
export type StrongNode = { type: "strong"; children: PhrasingNode[] };
export type LinkNode = { type: "link"; url: string; title?: string; children: PhrasingNode[] };
export type ImageNode = { type: "image"; url: string; alt: string; title?: string };
export type PhrasingNode = TextNode | EmphasisNode | StrongNode | InlineCodeNode | BreakNode | LinkNode | ImageNode;

export type HeadingNode = { type: "heading"; depth: 1 | 2 | 3 | 4 | 5 | 6; children: PhrasingNode[] };
export type ParagraphNode = { type: "paragraph"; children: PhrasingNode[] };
export type BlockquoteNode = { type: "blockquote"; children: BlockNode[] };
export type ListItemNode = { type: "listItem"; children: BlockNode[] };
export type ListNode = { type: "list"; ordered: boolean; start?: number; children: ListItemNode[] };
export type CodeNode = { type: "code"; lang?: string; value: string };
export type ThematicBreakNode = { type: "thematicBreak" };
/** A component with the props the author wrote: a string, or `true` for a bare attribute. */
export type ComponentNode = { type: "component"; name: string; props: Record<string, string | true>; children: BlockNode[] };
export type BlockNode = HeadingNode | ParagraphNode | BlockquoteNode | ListNode | CodeNode | ThematicBreakNode | ComponentNode;

export type LessonTree = { type: "root"; children: BlockNode[] };

const validateTree: ValidateFunction = newAjv().compile(lessonTreeSchema);

/** What is wrong with `tree` against `lesson-tree.schema.json`, as messages; empty when it conforms. */
export function treeErrors(tree: unknown): string[] {
  if (validateTree(tree)) return [];
  return (validateTree.errors ?? []).map((error) => `${error.instancePath === "" ? "the tree" : error.instancePath} ${error.message ?? "is not valid"}`);
}

/**
 * The tree as it is written to a file and printed by `compile`: UTF-8 text, LF line endings, a 2-space
 * indent, and a final newline. `JSON.stringify` indents with `\n` on every platform and keeps non-ASCII
 * text as it is.
 */
export function serializeTree(tree: LessonTree): string {
  return `${JSON.stringify(tree, null, 2)}\n`;
}
