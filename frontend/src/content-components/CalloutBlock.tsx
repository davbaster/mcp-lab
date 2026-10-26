import { Unavailable } from "./Unavailable";
import { checkCalloutProps, type CalloutType } from "./props";
import type { ContentComponentProps } from "./tree";

const LABELS: Record<CalloutType, string> = { tip: "Tip", warning: "Warning", note: "Note" };

/** The `Callout` component: a tip, warning or note, with its label first so color is never alone. */
export function CalloutBlock({ name, props, nodes, renderNodes }: ContentComponentProps) {
  const checked = checkCalloutProps(props);
  if (!checked.ok) return <Unavailable name={name} problem={checked.problem} />;
  const { type, title } = checked.value;
  return (
    <div className={`callout callout-${type}`} role="note">
      {/* Not a heading element, so the heading order of the lesson is not disturbed. */}
      <p className="callout-heading">
        <span className="callout-label">{LABELS[type]}</span>
        {title !== null && <span className="callout-title"> {title}</span>}
      </p>
      {renderNodes(nodes)}
    </div>
  );
}
