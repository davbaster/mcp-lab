/**
 * The compiled lesson tree, as the content build writes it (see content-build/README.md, "The
 * tree"). The API types `tree` as `unknown`, so nothing here trusts the shape: a guard checks
 * what a renderer is about to read.
 */
import type { ReactNode } from "react";

export type Props = Record<string, unknown>;

/** A node is any object; its `type` decides what it is, and the renderer checks the rest. */
export type TreeNode = Record<string, unknown>;

export interface LessonTree {
  type: "root";
  children: TreeNode[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string with something in it besides white space. */
export function isFilled(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** `{ "type": "root", "children": [...] }` where every child is an object. */
export function isLessonTree(value: unknown): value is LessonTree {
  return (
    isRecord(value) && value.type === "root" && Array.isArray(value.children) && value.children.every(isRecord)
  );
}

/** The `children` of a node, or an empty list when it has none (or not a list). */
export function childNodes(node: TreeNode): readonly unknown[] {
  return Array.isArray(node.children) ? node.children : [];
}

/** The text of a node and its descendants: `text` and `inlineCode` values, in order. */
export function textOf(node: unknown): string {
  // A loop with a stack, so a very deep tree cannot overflow the call stack.
  let text = "";
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!isRecord(current)) continue;
    if ((current.type === "text" || current.type === "inlineCode") && typeof current.value === "string") {
      text += current.value;
    }
    const kids = childNodes(current);
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
  }
  return text;
}

/** What the renderer hands to a content component. */
export interface ContentComponentProps {
  /** The `name` of the component node (already found in the registry). */
  name: string;
  /** The node's `props`; always an object, but its values are not checked yet. */
  props: Props;
  /** The node's children, for components that read them (Tabs) or render them (Callout). */
  nodes: readonly unknown[];
  /** Renders child nodes (Markdown and components) the way the page does. */
  renderNodes: (nodes: readonly unknown[]) => ReactNode;
}
