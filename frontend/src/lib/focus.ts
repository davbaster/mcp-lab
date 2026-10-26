/** Moves focus to the page's `h1` (see `PageHeading`). */
export function focusPageHeading(): void {
  document.querySelector<HTMLElement>("main h1")?.focus();
}
