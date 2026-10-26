import { useEffect, useRef } from "react";
import { useCodeSource, type CodeSource } from "./codeData";
import { CodeViewer } from "./CodeViewer";
import { Unavailable } from "./Unavailable";
import { checkCodeStepsProps } from "./props";
import type { ContentComponentProps } from "./tree";

export const CODE_STEP_UNAVAILABLE = "This code step can't be shown";

/** The box for a code step that cannot be shown, which is not the "Try again" kind of failure. */
function CodeUnavailable({ name, problem }: { name: string; problem: string }) {
  return <Unavailable name={name} problem={problem} message={CODE_STEP_UNAVAILABLE} />;
}

/**
 * The `CodeSteps` component. It checks its props, then reads the lesson's chapter code (one
 * request for all the viewers of a lesson; see `CodeDataProvider`) and shows the files of the
 * step named in `step`, from which the learner can move to the other steps of the chapter.
 */
export function CodeStepsBlock({ name, props }: ContentComponentProps) {
  const checked = checkCodeStepsProps(props);
  const source = useCodeSource();
  if (!checked.ok) return <Unavailable name={name} problem={checked.problem} />;
  if (source === null) {
    return <CodeUnavailable name={name} problem={`step ${checked.value.step}: the lesson's course and chapter are not known`} />;
  }
  return <LoadedSteps name={name} step={checked.value.step} file={checked.value.file} source={source} />;
}

function LoadedSteps({ name, step, file, source }: { name: string; step: number; file: string | null; source: CodeSource }) {
  const { state, ensure, retry } = source;
  const box = useRef<HTMLDivElement>(null);

  // The first viewer to mount starts the request; the others share it.
  useEffect(() => {
    ensure();
  }, [ensure]);

  function tryAgain() {
    // The button is about to be removed, so focus moves to the box that stays.
    box.current?.focus();
    retry();
  }

  let content;
  if (state.kind === "loading") {
    content = (
      <div className="code-steps-loading" role="status">
        Loading code…
      </div>
    );
  } else if (state.kind === "error") {
    content = (
      <div className="error-box" role="alert">
        <p>{state.message}</p>
        <button type="button" className="button" onClick={tryAgain}>
          Try again
        </button>
      </div>
    );
  } else {
    const start = state.code.steps.findIndex((candidate) => candidate.step === step);
    // The step named in the prop is where the viewer starts; it has to be there and hold a file.
    content =
      start < 0 || state.code.steps[start].files.length === 0 ? (
        <CodeUnavailable name={name} problem={`step ${step} is not in the chapter's code, or it has no file to show`} />
      ) : (
        <CodeViewer
          key={JSON.stringify([step, file])}
          name={name}
          steps={state.code.steps}
          start={start}
          file={file}
          zipUrl={state.code.zip.url}
          zipFileName={state.code.zip.fileName}
        />
      );
  }

  return (
    <div className="code-steps" ref={box} tabIndex={-1}>
      {content}
    </div>
  );
}
