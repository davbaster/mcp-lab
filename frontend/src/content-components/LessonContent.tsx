import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import "./content.css";
import { CodeDataProvider } from "./CodeDataProvider";
import { LessonImage } from "./LessonImage";
import { LogOnce } from "./LogOnce";
import { Unavailable } from "./Unavailable";
import { lookupComponent } from "./registry";
import { childNodes, isFilled, isRecord, textOf, type LessonTree, type TreeNode } from "./tree";
import { classifyLink, siteSource } from "./urls";

/**
 * Renders a compiled lesson tree as React elements. Every string from the tree goes in as a React
 * child or attribute value, so it is always text; nothing here builds HTML from it. A node that
 * is not understood is skipped (and logged), so one bad node never takes the page down.
 */

const CODE_LANGUAGE = /^[A-Za-z0-9_+#.-]+$/;

function skipped(type: unknown, why: string): ReactNode {
  const label = typeof type === "string" ? type.slice(0, 60) : "(none)";
  return <LogOnce level="warn" message={`Skipped a lesson node of type "${label}": ${why}`} />;
}

function renderNodes(nodes: readonly unknown[]): ReactNode {
  return nodes.map((node, index) => <Fragment key={index}>{renderNode(node)}</Fragment>);
}

function renderChildren(node: TreeNode): ReactNode {
  return renderNodes(childNodes(node));
}

function renderNode(node: unknown): ReactNode {
  if (!isRecord(node)) return skipped(undefined, "it is not an object");
  switch (node.type) {
    case "text":
      return typeof node.value === "string" ? node.value : skipped("text", "it has no value");
    case "paragraph":
      return <p>{renderChildren(node)}</p>;
    case "heading":
      return renderHeading(node);
    case "emphasis":
      return <em>{renderChildren(node)}</em>;
    case "strong":
      return <strong>{renderChildren(node)}</strong>;
    case "inlineCode":
      return <code>{typeof node.value === "string" ? node.value : ""}</code>;
    case "break":
      return <br />;
    case "blockquote":
      return <blockquote>{renderChildren(node)}</blockquote>;
    case "thematicBreak":
      return <hr />;
    case "list": {
      const start = typeof node.start === "number" && Number.isInteger(node.start) ? node.start : undefined;
      return node.ordered === true ? <ol start={start}>{renderChildren(node)}</ol> : <ul>{renderChildren(node)}</ul>;
    }
    case "listItem":
      return <li>{renderChildren(node)}</li>;
    case "code":
      return renderCode(node);
    case "link":
      return renderLink(node);
    case "image":
      return renderMarkdownImage(node);
    case "component":
      return renderComponent(node);
    default:
      return skipped(node.type, "unknown node type");
  }
}

function renderHeading(node: TreeNode): ReactNode {
  const depth = node.depth;
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1 || depth > 6) {
    return skipped("heading", "its depth is not 1 to 6");
  }
  // The page's own `h1` is the lesson title, so a depth-1 heading in the lesson is an `h2`.
  const Tag = `h${Math.max(depth, 2)}` as "h2" | "h3" | "h4" | "h5" | "h6";
  return <Tag>{renderChildren(node)}</Tag>;
}

function renderCode(node: TreeNode): ReactNode {
  const lang = typeof node.lang === "string" && CODE_LANGUAGE.test(node.lang) ? node.lang : null;
  // The `pre` can be focused, so a wide block can be scrolled with the keyboard.
  return (
    <pre tabIndex={0}>
      <code className={lang ? `language-${lang}` : undefined}>{typeof node.value === "string" ? node.value : ""}</code>
    </pre>
  );
}

function renderLink(node: TreeNode): ReactNode {
  const target = classifyLink(node.url);
  const content = renderChildren(node);
  const title = isFilled(node.title) ? node.title : undefined;
  switch (target.kind) {
    case "app":
      return (
        <Link to={target.to} title={title}>
          {content}
        </Link>
      );
    case "plain":
      return (
        <a href={target.href} title={title}>
          {content}
        </a>
      );
    case "external":
      return (
        <a href={target.href} title={title} target="_blank" rel="noopener noreferrer">
          {content}
        </a>
      );
    case "text":
      return content;
  }
}

function renderMarkdownImage(node: TreeNode): ReactNode {
  const alt = typeof node.alt === "string" ? node.alt : "";
  const src = siteSource(node.url);
  // A source that is not a path on this site is not used; the alt text is all that is left.
  if (src === null) return alt;
  return <LessonImage src={src} alt={alt} title={isFilled(node.title) ? node.title : undefined} block={false} />;
}

function renderComponent(node: TreeNode): ReactNode {
  const name = typeof node.name === "string" ? node.name.slice(0, 60) : "(none)";
  const Component = lookupComponent(node.name);
  if (!Component) return <Unavailable name={name} problem="it is not a known component" />;
  return (
    <Component
      name={name}
      props={isRecord(node.props) ? node.props : {}}
      nodes={childNodes(node)}
      renderNodes={renderNodes}
    />
  );
}

/** True when the tree starts with an `h1` that only repeats the lesson title. */
function startsWithTitle(tree: LessonTree, title: string): boolean {
  const first = tree.children[0];
  return first?.type === "heading" && first.depth === 1 && textOf(first).trim() === title.trim();
}

/** The course and chapter a lesson belongs to, which `CodeSteps` needs to ask for the chapter's code. */
export interface LessonIds {
  courseId: string;
  chapterId: string;
}

/**
 * The lesson body. `title` is the lesson title the page shows as its `h1`: a leading `# Title`
 * line that repeats it is not rendered again. `lesson` gives the IDs for `CodeSteps`; without it
 * a `CodeSteps` cannot be shown and sends no request.
 */
export function LessonContent({ tree, title, lesson }: { tree: LessonTree; title: string; lesson?: LessonIds }) {
  const nodes = startsWithTitle(tree, title) ? tree.children.slice(1) : tree.children;
  const content = <div className="lesson-content">{renderNodes(nodes)}</div>;
  if (!lesson) return content;
  // Keyed, so the code of one chapter is never shown for another.
  return (
    <CodeDataProvider key={`${lesson.courseId}/${lesson.chapterId}`} courseId={lesson.courseId} chapterId={lesson.chapterId}>
      {content}
    </CodeDataProvider>
  );
}
