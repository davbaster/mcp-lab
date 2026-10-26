import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { UNEXPECTED_RESPONSE_MESSAGE } from "../api/apiError";
import { api } from "../api/client";
import { settle } from "../api/settle";
import { CodeSourceContext, readChapterCode, type CodeSource, type CodeState } from "./codeData";

/**
 * Holds the chapter's code for the lesson that is on the page. It sends no request until a viewer
 * asks (`ensure`), so a lesson without `CodeSteps` sends none, and it sends one for any number of
 * viewers. The state is local to this component, so leaving the lesson drops the code.
 */
export function CodeDataProvider({ courseId, chapterId, children }: { courseId: string; chapterId: string; children: ReactNode }) {
  const [state, setState] = useState<CodeState>({ kind: "loading" });
  const requestId = useRef(0);
  const started = useRef(false);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setState((previous) => (previous.kind === "loading" ? previous : { kind: "loading" }));
    const result = await settle(
      api.GET("/api/courses/{course_id}/chapters/{chapter_id}/code", {
        params: { path: { course_id: courseId, chapter_id: chapterId } },
      }),
    );
    let next: CodeState;
    if ("failure" in result) {
      next = { kind: "error", message: result.failure.message };
    } else {
      const code = readChapterCode(result.data);
      next = code ? { kind: "loaded", code } : { kind: "error", message: UNEXPECTED_RESPONSE_MESSAGE };
    }
    // Only the newest request may update the viewers.
    if (id === requestId.current) setState(next);
  }, [courseId, chapterId]);

  const ensure = useCallback(() => {
    if (started.current) return;
    started.current = true;
    void load();
  }, [load]);

  const retry = useCallback(() => {
    void load();
  }, [load]);

  const source = useMemo<CodeSource>(() => ({ state, ensure, retry }), [state, ensure, retry]);
  return <CodeSourceContext.Provider value={source}>{children}</CodeSourceContext.Provider>;
}
