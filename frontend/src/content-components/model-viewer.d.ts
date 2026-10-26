import type { DetailedHTMLProps, HTMLAttributes } from "react";

/** The attributes of the `<model-viewer>` element that `Model3DBlock` sets. */
interface ModelViewerAttributes extends DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> {
  src?: string;
  alt?: string;
  poster?: string;
  loading?: "auto" | "lazy" | "eager";
  "camera-controls"?: boolean;
  "touch-action"?: string;
  "interaction-prompt"?: "auto" | "none";
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": ModelViewerAttributes;
    }
  }
}
