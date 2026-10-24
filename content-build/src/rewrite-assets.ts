// Points the asset references of a compiled lesson at the hashed files that the backend serves.

import { assetUrl, isUrl, referenceRule } from "./assets.ts";
import { treeErrors } from "./lesson-tree.ts";
import type { BlockNode, LessonTree, PhrasingNode } from "./lesson-tree.ts";

/** Original path from assets/ to its entry: the `files` of the map that `writeAssets` writes (only `file` is read). */
export type AssetMap = Readonly<Record<string, { readonly file: string }>>;

/**
 * Returns a new tree in which every asset reference (an `Image`, `Diagram`, `Model3D`, or `Video` prop that
 * names a file in assets/, and a Markdown image) is `/api/courses/<courseId>/assets/<hashed file name>`.
 * The props come from the same table as the checks. A value that is a URL (an allowlisted `Video` poster or
 * captions) and `Video.src` are left alone. `tree` is not changed. A reference that has no entry in
 * `assetMap` throws an internal error, because the checks should have caught it.
 */
export function rewriteAssetUrls(tree: LessonTree, courseId: string, assetMap: AssetMap): LessonTree {
  const rewrite = (path: string): string => {
    const entry = Object.hasOwn(assetMap, path) ? assetMap[path] : undefined;
    if (entry === undefined) throw new Error(`internal error: the asset \`${path}\` is not in the asset map, though the checks should have rejected the lesson`);
    return assetUrl(courseId, entry.file);
  };

  const phrasing = (node: PhrasingNode): PhrasingNode => {
    switch (node.type) {
      case "image":
        return isUrl(node.url) ? { ...node } : { ...node, url: rewrite(node.url) };
      case "emphasis":
      case "strong":
      case "link":
        return { ...node, children: node.children.map(phrasing) };
      default:
        return { ...node };
    }
  };

  const block = (node: BlockNode): BlockNode => {
    switch (node.type) {
      case "heading":
      case "paragraph":
        return { ...node, children: node.children.map(phrasing) };
      case "blockquote":
        return { ...node, children: node.children.map(block) };
      case "list":
        return { ...node, children: node.children.map((item) => ({ ...item, children: item.children.map(block) })) };
      case "component": {
        const props = { ...node.props };
        for (const [name, value] of Object.entries(node.props)) {
          const rule = referenceRule(node.name, name);
          if (rule === undefined || rule.kind === "video" || typeof value !== "string" || isUrl(value)) continue;
          props[name] = rewrite(value);
        }
        return { ...node, props, children: node.children.map(block) };
      }
      default:
        return { ...node };
    }
  };

  const result: LessonTree = { type: "root", children: tree.children.map(block) };
  const wrong = treeErrors(result);
  if (wrong.length > 0) throw new Error(`internal error: the rewritten tree does not match lesson-tree.schema.json: ${wrong.join("; ")}`);
  return result;
}
