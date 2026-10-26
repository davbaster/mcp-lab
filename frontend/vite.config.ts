import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => {
  // Read in Node (the empty prefix lets loadEnv return variables without VITE_), so it is never
  // part of the browser bundle. Real environment variables win over .env files.
  const apiProxyTarget = loadEnv(mode, ".", "").API_PROXY_TARGET || "http://localhost:8000";

  return {
    plugins: [react()],
    resolve: {
      alias: [
        {
          // <model-viewer> imports this three.js module but never uses it here, and evaluating it compiles
          // WebAssembly, which the Content-Security-Policy refuses. See the stub for the full reason.
          find: /^three\/examples\/jsm\/libs\/meshopt_decoder\.module\.js$/,
          // Relative to the project root, so it is the same on every platform.
          replacement: "/src/content-components/meshoptDecoderStub.ts",
        },
      ],
    },
    // Dev server only. `vite preview` copies `server.proxy` unless `preview.proxy` is set, so
    // it is set to an empty object. The production build never proxies.
    // In Docker and production, Caddy routes /api to the backend.
    server: {
      proxy: {
        "/api": apiProxyTarget,
      },
    },
    preview: {
      proxy: {},
    },
    test: {
      environment: "jsdom",
      // By default Vitest turns every CSS import into an empty string, even `?raw`. The tokens
      // test reads the real CSS files.
      css: { include: [/.+/] },
    },
  };
});
