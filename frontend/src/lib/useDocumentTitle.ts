import { useEffect } from "react";

/** "<Page> – Courses" (with an en dash), or just "Courses" for the course list. */
export function pageTitle(name?: string): string {
  return name ? `${name} – Courses` : "Courses";
}

/** Sets `document.title` for the page that calls it. */
export function useDocumentTitle(name?: string): void {
  useEffect(() => {
    document.title = pageTitle(name);
  }, [name]);
}
