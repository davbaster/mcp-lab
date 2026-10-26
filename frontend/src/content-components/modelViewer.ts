/**
 * Loads `<model-viewer>` (which brings three.js) on demand. It is a separate chunk: the only
 * reference to the package is this dynamic `import()`, and it runs the first time a `Model3D`
 * that will show a model asks for it. Every later call shares the same promise, so a lesson with
 * two models loads it once. A failed load is forgotten, so a later press of "Load 3D model" tries again.
 * The package registers the `model-viewer` element when it is imported.
 */

let loading: Promise<unknown> | undefined;

export function loadModelViewer(): Promise<unknown> {
  loading ??= import("@google/model-viewer").catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}
