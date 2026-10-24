import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => {
  // Read in Node (the empty prefix lets loadEnv return variables without VITE_), so it is never
  // part of the browser bundle. Real environment variables win over .env files.
  const apiProxyTarget = loadEnv(mode, ".", "").API_PROXY_TARGET || "http://localhost:8000";

  return {
    plugins: [react()],
    // Dev server only: `npm run preview` and the production build do not proxy.
    // In Docker and production, Caddy routes /api to the backend.
    server: {
      proxy: {
        "/api": apiProxyTarget,
      },
    },
    test: {
      environment: "jsdom",
    },
  };
});
