import { useEffect, useRef, useState } from "react";
import { Unavailable } from "./Unavailable";
import { loadModelViewer } from "./modelViewer";
import { checkModel3DProps } from "./props";
import type { ContentComponentProps } from "./tree";
import { useReducedMotion } from "./useReducedMotion";
import { webglAvailable } from "./webgl";

/** Below this window width, or with this many cores or fewer, the model waits for a button press. */
const NARROW_PX = 480;
const LOW_CORES = 2;

type Mode =
  /** Load `<model-viewer>` and show the model. */
  | "viewer"
  /** Show the poster and a button; load nothing until the button is pressed. */
  | "button"
  /** Show the poster only: the browser cannot draw WebGL. */
  | "poster";

/** Decided once, when the component mounts. A later resize does not unload a model. */
function chooseMode(): Mode {
  if (!webglAvailable()) return "poster";
  const cores: unknown = navigator.hardwareConcurrency;
  // A browser that does not say how many cores it has is not treated as low-end.
  const fewCores = typeof cores === "number" && cores <= LOW_CORES;
  return window.innerWidth < NARROW_PX || fewCores ? "button" : "viewer";
}

/**
 * Moves keyboard focus into the viewer's own focusable part, the one that rotates with the arrow
 * keys. `<model-viewer>` keeps it in its shadow DOM and only shows it (`display: none` before) once
 * the model is revealed, so this is called then; the element itself is the fallback.
 */
async function focusInsideViewer(viewer: HTMLElement): Promise<void> {
  await (viewer as HTMLElement & { updateComplete?: Promise<unknown> }).updateComplete;
  (viewer.shadowRoot?.querySelector<HTMLElement>("[tabindex='0']") ?? viewer).focus();
}

function ModelFrame({ src, alt, poster }: { src: string; alt: string; poster: string }) {
  const [mode] = useState(chooseMode);
  // The viewer is wanted from the start, or after the button is pressed.
  const [pressed, setPressed] = useState(false);
  const wanted = mode === "viewer" || pressed;
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const reducedMotion = useReducedMotion();
  const viewer = useRef<HTMLElement>(null);

  // Starts the download of the model-viewer code. Every Model3D calls the same loader.
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    loadModelViewer().then(
      () => current && setLoaded(true),
      () => current && setFailed(true),
    );
    return () => {
      current = false;
    };
  }, [wanted]);

  // Focus follows the learner's press (not the automatic load). The button is about to go, so focus
  // moves to the viewer element at once, so it is not lost, and into the viewer once it shows the model.
  useEffect(() => {
    if (pressed) viewer.current?.focus();
  }, [pressed]);

  // The model file failing, or WebGL being lost, fires `error` on the element. `model-visibility` fires when
  // the model is shown.
  useEffect(() => {
    const element = viewer.current;
    if (element === null || failed) return;
    const onError = () => setFailed(true);
    const onVisibility = (event: Event) => {
      const focus = document.activeElement;
      const lost = focus === null || focus === document.body || focus === element;
      if (pressed && lost && (event as CustomEvent<{ visible?: boolean }>).detail?.visible === true) void focusInsideViewer(element);
    };
    element.addEventListener("error", onError);
    element.addEventListener("model-visibility", onVisibility);
    return () => {
      element.removeEventListener("error", onError);
      element.removeEventListener("model-visibility", onVisibility);
    };
  }, [wanted, failed, pressed]);

  const showViewer = wanted && !failed;
  const showPoster = !showViewer || !loaded;
  return (
    <div className="model3d">
      <div className="media-frame model-frame">
        {showViewer && (
          <model-viewer
            ref={viewer}
            className="model-viewer"
            src={src}
            alt={alt}
            poster={poster}
            camera-controls
            loading="lazy"
            touch-action="pan-y"
            interaction-prompt={reducedMotion ? "none" : undefined}
            tabIndex={-1}
          />
        )}
        {showPoster && <img className="model-poster" src={poster} alt={alt} loading="lazy" />}
        {mode === "button" && !failed && !loaded && (
          <button type="button" className="button model-load" disabled={pressed} onClick={() => setPressed(true)}>
            {pressed ? "Loading 3D model…" : "Load 3D model"}
          </button>
        )}
      </div>
      {mode === "poster" && <p className="model-note">3D view is not available on this device</p>}
      {failed && (
        <p className="model-note" role="status">
          This 3D model could not be loaded.
        </p>
      )}
    </div>
  );
}

/**
 * The `Model3D` component: an interactive model in `<model-viewer>`. The viewer's code (a large
 * chunk with three.js) is imported only when a model will be shown. On a small screen or a device
 * with few cores the poster waits for the button "Load 3D model"; with no WebGL there is only the
 * poster. With reduced motion the viewer does not show its animated hint.
 */
export function Model3DBlock({ name, props }: ContentComponentProps) {
  const checked = checkModel3DProps(props);
  if (!checked.ok) return <Unavailable name={name} problem={checked.problem} />;
  return <ModelFrame src={checked.value.src} alt={checked.value.alt} poster={checked.value.poster} />;
}
