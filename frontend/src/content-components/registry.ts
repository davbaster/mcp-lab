import type { ComponentType } from "react";
import { CalloutBlock } from "./CalloutBlock";
import { CodeStepsBlock } from "./CodeStepsBlock";
import { DiagramBlock } from "./DiagramBlock";
import { ImageBlock } from "./LessonImage";
import { PendingComponent } from "./PendingComponent";
import { TabsBlock } from "./TabsBlock";
import type { ContentComponentProps } from "./tree";

export type ContentComponent = ComponentType<ContentComponentProps>;

/**
 * The components a lesson may use: one entry for each schema in `schemas/`. It is a fixed object
 * in code and is never built from lesson data. `Tab` is not here: it is part of `Tabs`
 * (`x-nested` in `Tabs.schema.json`), so a `Tab` outside `Tabs` is an unknown component.
 *
 * `Video` and `Model3D` show the "can't be shown" box until #20 builds them; `registry.test.ts`
 * lists them as pending.
 */
export const registry = {
  Image: ImageBlock,
  Callout: CalloutBlock,
  Tabs: TabsBlock,
  Diagram: DiagramBlock,
  Video: PendingComponent,
  Model3D: PendingComponent,
  CodeSteps: CodeStepsBlock,
} satisfies Record<string, ContentComponent>;

/** The component for a name from lesson data, or undefined. `__proto__` and `toString` are not names. */
export function lookupComponent(name: unknown): ContentComponent | undefined {
  return typeof name === "string" && Object.hasOwn(registry, name)
    ? (registry as Record<string, ContentComponent>)[name]
    : undefined;
}
