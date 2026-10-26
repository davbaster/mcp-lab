import { describe, expect, it } from "vitest";
import { Model3DBlock } from "./Model3DBlock";
import { PendingComponent } from "./PendingComponent";
import { lookupComponent, registry } from "./registry";
import { VideoBlock } from "./VideoBlock";

/**
 * Components that have a schema but no component yet. They map to PendingComponent. Every
 * component is built, so the list is empty; a new schema adds its name here until its component
 * exists.
 */
const PENDING: string[] = [];

const schemas = import.meta.glob("./schemas/*.schema.json", { eager: true, import: "default" });
const schemaNames = Object.keys(schemas).map((path) => /\/([^/]+)\.schema\.json$/.exec(path)?.[1] as string);

describe("the registry and the schemas", () => {
  it("finds the schema files", () => {
    expect(schemaNames.length).toBeGreaterThanOrEqual(7);
  });

  it("has an entry for every schema", () => {
    expect(schemaNames.filter((name) => !Object.hasOwn(registry, name))).toEqual([]);
  });

  it("has a schema for every entry", () => {
    expect(Object.keys(registry).filter((name) => !schemaNames.includes(name))).toEqual([]);
  });

  it("uses the placeholder for exactly the pending components", () => {
    const placeholders = Object.entries(registry)
      .filter(([, component]) => component === PendingComponent)
      .map(([name]) => name)
      .sort();
    expect(placeholders).toEqual(PENDING);
  });

  it("maps Video and Model3D to their own components", () => {
    expect(registry.Video).toBe(VideoBlock);
    expect(registry.Model3D).toBe(Model3DBlock);
  });

  it("does not list a pending component that has no schema", () => {
    expect(PENDING.filter((name) => !schemaNames.includes(name))).toEqual([]);
  });

  it("does not have Tab: it is part of Tabs (x-nested)", () => {
    expect(Object.hasOwn(registry, "Tab")).toBe(false);
    const tabs = schemas["./schemas/Tabs.schema.json"] as { "x-nested": Record<string, unknown> };
    expect(Object.keys(tabs["x-nested"])).toEqual(["Tab"]);
  });
});

describe("lookupComponent", () => {
  it("finds a component by name", () => {
    expect(lookupComponent("Callout")).toBe(registry.Callout);
  });

  it.each(["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf", "Tab", "callout", ""])(
    "does not find %j",
    (name) => {
      expect(lookupComponent(name)).toBeUndefined();
    },
  );

  it.each([undefined, null, 1, {}, ["Callout"]])("does not find a name that is %j", (name) => {
    expect(lookupComponent(name)).toBeUndefined();
  });
});
