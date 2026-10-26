/**
 * Stands in for three.js's `meshopt_decoder.module.js` (see `resolve.alias` in vite.config.ts).
 *
 * `<model-viewer>` imports that module for its `meshopt-decoder-location` option, which this app never
 * sets. But the real module compiles a WebAssembly decoder as soon as it is evaluated, which the
 * Content-Security-Policy refuses (`script-src 'self'` has no `'wasm-unsafe-eval'`, on purpose), so every
 * page with a model would log a CSP violation and an unhandled rejection. A model that needs the decoder
 * fails to load and shows "This 3D model could not be loaded.", as the decided policy says.
 */
export const MeshoptDecoder = {
  supported: false,
  ready: Promise.resolve(),
};
