import { optimizeDeps, resolveConfig } from "vite";
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
it("replaces three.js's Meshopt decoder module with the stub, by an absolute file path", async () => {
  const config = await resolveConfig({ configFile: "vite.config.ts" }, "build");
  const alias = (config.resolve.alias as { find: RegExp | string; replacement: string }[]).find((entry) =>
    String(entry.find).includes("meshopt_decoder"),
  );

  // "/src/..." would be read by the dependency optimizer as a folder at the root of the file system.
  expect(alias?.replacement).toMatch(/^(\/|[A-Za-z]:[\\/]).+[\\/]src[\\/]content-components[\\/]meshoptDecoderStub\.ts$/);
  expect(alias?.replacement.startsWith("/src/")).toBe(false);
  expect((alias?.find as RegExp).test("three/examples/jsm/libs/meshopt_decoder.module.js")).toBe(true);
  expect((alias?.find as RegExp).test("three/examples/jsm/libs/draco/draco_decoder.js")).toBe(false);
});

// `npm run dev` prebundles @google/model-viewer. The alias must work there too: with the path "/src/..." the
// dev server did not start ("Could not load .../src/content-components/meshoptDecoderStub.ts").
it("prebundles @google/model-viewer for the dev server", async () => {
  const config = await resolveConfig({ configFile: "vite.config.ts", cacheDir: "node_modules/.vite-test" }, "serve");
  const metadata = await optimizeDeps(config, true);

  expect(Object.keys(metadata.optimized)).toContain("@google/model-viewer");
}, 120_000);
