import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { LogOnce } from "./LogOnce";
import { Unavailable } from "./Unavailable";
import { checkTabProps } from "./props";
import { tabForKey } from "./tabKeys";
import { childNodes, isRecord, type ContentComponentProps } from "./tree";

interface TabData {
  label: string;
  content: ReactNode;
}

/**
 * The `Tabs` component, following the WAI-ARIA tabs pattern with automatic activation. Every
 * panel stays mounted (the others are `hidden`), so a tab's content keeps its state and its
 * problems are logged once, not again each time the learner switches tabs.
 */
export function TabsBlock({ name, nodes, renderNodes }: ContentComponentProps) {
  const base = useId();
  const [selected, setSelected] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  // `Tab` has no schema file of its own: it is declared inside `Tabs.schema.json` (x-nested).
  const tabs: TabData[] = [];
  const problems: string[] = [];
  for (const node of nodes) {
    if (!isRecord(node) || node.type !== "component" || node.name !== "Tab") {
      problems.push("a child of Tabs is not a Tab");
      continue;
    }
    const checked = checkTabProps(isRecord(node.props) ? node.props : {});
    if (!checked.ok) {
      problems.push(`a Tab: ${checked.problem}`);
      continue;
    }
    tabs.push({ label: checked.value.label, content: renderNodes(childNodes(node)) });
  }

  if (tabs.length === 0) return <Unavailable name={name} problem={problems[0] ?? "it has no Tab"} />;

  const active = Math.min(selected, tabs.length - 1);
  const last = tabs.length - 1;

  function select(index: number, focus: boolean) {
    setSelected(index);
    if (focus) buttons.current[index]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = tabForKey(event, active, last);
    if (next === null) return;
    event.preventDefault();
    select(next, true);
  }

  return (
    <div className="tabs">
      {problems.length > 0 && <LogOnce level="error" message={`Lesson component "${name}" has a problem: ${problems[0]}`} />}
      <div className="tablist" role="tablist" onKeyDown={onKeyDown}>
        {tabs.map((tab, index) => (
          <button
            key={index}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="tab"
            className="tab"
            id={`${base}-tab-${index}`}
            aria-selected={index === active}
            aria-controls={`${base}-panel-${index}`}
            tabIndex={index === active ? 0 : -1}
            onClick={() => select(index, false)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab, index) => (
        <div
          key={index}
          className="tabpanel"
          role="tabpanel"
          id={`${base}-panel-${index}`}
          aria-labelledby={`${base}-tab-${index}`}
          tabIndex={0}
          hidden={index !== active}
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}
