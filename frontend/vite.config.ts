import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// The file path of the stub (no `node:` import: this project has no Node type definitions). A Windows path
// comes out of `new URL` as "/C:/...", so the slash before the drive letter is dropped.
const stubPath = decodeURIComponent(new URL("./src/content-components/meshoptDecoderStub.ts", import.meta.url).pathname).replace(
  /^\/(?=[A-Za-z]:)/,
  "",
);

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
          // An absolute file path. The dependency optimizer of `npm run dev` resolves this alias too, and it
          // reads a path that starts with "/src" as a folder of the file system, not of the project.
          replacement: stubPath,
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
