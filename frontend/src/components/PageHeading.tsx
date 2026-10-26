import type { ReactNode } from "react";

/** The one `h1` of a page. It can take programmatic focus (see `focusPageHeading`). */
export function PageHeading({ children }: { children: ReactNode }) {
  return <h1 tabIndex={-1}>{children}</h1>;
}
