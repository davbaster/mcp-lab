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

// <model-viewer> imports three.js's Meshopt decoder, whose module compiles WebAssembly when it is
// evaluated. The Content-Security-Policy has no 'wasm-unsafe-eval', so that would be a CSP violation
// on every page with a model; the module is replaced by a stub that says it is not supported.
it("replaces three.js's Meshopt decoder module with the stub", async () => {
  const config = await resolveConfig({ configFile: "vite.config.ts" }, "build");
  const alias = (config.resolve.alias as { find: RegExp | string; replacement: string }[]).find((entry) =>
    String(entry.find).includes("meshopt_decoder"),
  );

  expect(alias?.replacement).toBe("/src/content-components/meshoptDecoderStub.ts");
  expect((alias?.find as RegExp).test("three/examples/jsm/libs/meshopt_decoder.module.js")).toBe(true);
  expect((alias?.find as RegExp).test("three/examples/jsm/libs/draco/draco_decoder.js")).toBe(false);
});
