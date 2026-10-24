import { resolveConfig } from "vite";
import { expect, it } from "vitest";

// The criterion: the /api proxy applies to `npm run dev` only, not to `vite preview`.
// Vite's preview.proxy defaults to server.proxy, so it has to be set explicitly.
it("proxies /api for the dev server", async () => {
  const config = await resolveConfig({ configFile: "vite.config.ts" }, "serve");

  expect(Object.keys(config.server.proxy ?? {})).toEqual(["/api"]);
});

it("does not proxy anything for vite preview", async () => {
  const config = await resolveConfig({ configFile: "vite.config.ts" }, "serve");

  expect(config.preview.proxy).toEqual({});
});
