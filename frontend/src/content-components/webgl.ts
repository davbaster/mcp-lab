/**
 * Whether the browser can draw WebGL, which `<model-viewer>` needs. It is checked once per page: a
 * page may only hold a few WebGL contexts, so the test context is lost on purpose right after
 * the check and never kept.
 */

let supported: boolean | undefined;

function tryContext(canvas: HTMLCanvasElement, kind: "webgl2" | "webgl"): boolean {
  let context: WebGLRenderingContext | WebGL2RenderingContext | null;
  try {
    context = canvas.getContext(kind) as WebGLRenderingContext | WebGL2RenderingContext | null;
  } catch {
    return false;
  }
  if (context === null) return false;
  // Gives the context back to the browser now, not when the garbage collector gets to it.
  try {
    context.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    // The context worked; losing it early is only tidiness.
  }
  return true;
}

export function webglAvailable(): boolean {
  if (supported === undefined) {
    const canvas = document.createElement("canvas");
    supported = tryContext(canvas, "webgl2") || tryContext(canvas, "webgl");
  }
  return supported;
}

/** For tests: forget the answer, as a new page would. */
export function forgetWebglCheck(): void {
  supported = undefined;
}
