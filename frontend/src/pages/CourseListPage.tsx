import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { toApiError } from "../api/apiError";
import { api } from "../api/client";
import type { components } from "../api/schema";
import { PageHeading } from "../components/PageHeading";
import { useDocumentTitle } from "../lib/useDocumentTitle";

type CourseSummary = components["schemas"]["CourseSummary"];

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; courses: CourseSummary[] };

function chapterCount(count: number): string {
  return `${count} ${count === 1 ? "chapter" : "chapters"}`;
}

export function CourseListPage() {
  useDocumentTitle();
  const [state, setState] = useState<State>({ kind: "loading" });
  const results = useRef<HTMLElement>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    let next: State;
    try {
      const { data, error, response } = await api.GET("/api/courses");
      next =
        response.ok && data
          ? { kind: "loaded", courses: data.courses }
          : { kind: "error", message: toApiError(error, response).message };
    } catch (thrown) {
      next = { kind: "error", message: toApiError(thrown).message };
    }
    // Only the newest request may update the page.
    if (id === requestId.current) setState(next);
  }, []);

  useEffect(() => {
    void load();
    return () => {
      requestId.current += 1;
    };
  }, [load]);

  function tryAgain() {
    setState({ kind: "loading" });
    // The button is about to be removed, so focus moves to the region that stays.
    results.current?.focus();
    void load();
  }

  return (
    <>
      <PageHeading>Courses</PageHeading>
      <section aria-label="Course list" ref={results} tabIndex={-1}>
        {state.kind === "loading" && <p role="status">Loading…</p>}
        {state.kind === "error" && (
          <div role="alert">
            <p>{state.message}</p>
            <button type="button" className="button" onClick={tryAgain}>
              Try again
            </button>
          </div>
        )}
        {state.kind === "loaded" && state.courses.length === 0 && <p>No courses available yet.</p>}
        {state.kind === "loaded" && state.courses.length > 0 && (
          <ul className="course-list">
            {state.courses.map((course) => (
              <li key={course.id} className="course-card">
                <h2>
                  <Link to={`/courses/${encodeURIComponent(course.id)}`}>{course.title}</Link>
                </h2>
                <p>{course.description}</p>
                <p className="muted">{chapterCount(course.chapter_count)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
