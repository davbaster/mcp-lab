import type { ComponentType } from "react";
import { CalloutBlock } from "./CalloutBlock";
import { CodeStepsBlock } from "./CodeStepsBlock";
import { DiagramBlock } from "./DiagramBlock";
import { ImageBlock } from "./LessonImage";
import { Model3DBlock } from "./Model3DBlock";
import { TabsBlock } from "./TabsBlock";
import { VideoBlock } from "./VideoBlock";
import type { ContentComponentProps } from "./tree";

export type ContentComponent = ComponentType<ContentComponentProps>;

/**
 * The components a lesson may use: one entry for each schema in `schemas/`. It is a fixed object
 * in code and is never built from lesson data. `Tab` is not here: it is part of `Tabs`
 * (`x-nested` in `Tabs.schema.json`), so a `Tab` outside `Tabs` is an unknown component.
 *
 * A component that has a schema but is not built yet maps to `PendingComponent`, and
 * `registry.test.ts` lists it as pending.
 */
export const registry = {
  Image: ImageBlock,
  Callout: CalloutBlock,
  Tabs: TabsBlock,
  Diagram: DiagramBlock,
  Video: VideoBlock,
  Model3D: Model3DBlock,
  CodeSteps: CodeStepsBlock,
} satisfies Record<string, ContentComponent>;

/** The component for a name from lesson data, or undefined. `__proto__` and `toString` are not names. */
export function lookupComponent(name: unknown): ContentComponent | undefined {
  return typeof name === "string" && Object.hasOwn(registry, name)
    ? (registry as Record<string, ContentComponent>)[name]
    : undefined;
}
