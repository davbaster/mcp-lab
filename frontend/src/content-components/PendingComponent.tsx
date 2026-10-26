import { Unavailable } from "./Unavailable";
import type { ContentComponentProps } from "./tree";

/**
 * Stands in for a component that has a schema but is not built yet (#20). It shows the
 * "can't be shown" box and does not log: this is not a mistake in the lesson.
 */
export function PendingComponent({ name }: ContentComponentProps) {
  return <Unavailable name={name} problem={null} />;
}
