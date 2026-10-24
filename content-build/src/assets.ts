// What the content build knows about assets: the allowed file types, which lesson props refer to a file in
// assets/ or to a media URL, and the names of the files and URLs that come out.

/** The file types of `assets/`, by lowercase extension without the dot. */
export type AssetType = "png" | "jpg" | "jpeg" | "webp" | "svg" | "glb" | "gltf" | "vtt";

export const ASSET_TYPES: readonly AssetType[] = ["png", "jpg", "jpeg", "webp", "svg", "glb", "gltf", "vtt"];

export const IMAGE_TYPES: readonly AssetType[] = ["png", "jpg", "jpeg", "webp", "svg"];
export const MODEL_TYPES: readonly AssetType[] = ["glb", "gltf"];

/** Video files are never kept in assets/; the message for them says where they go. */
export const VIDEO_EXTENSIONS: readonly string[] = ["mp4", "webm", "mov", "m4v", "ogv"];

/** What a lesson prop refers to, and so which files it accepts. */
export type ReferenceKind = "image" | "svg" | "model" | "captions" | "video";

export type ReferenceRule = {
  kind: ReferenceKind;
  /** The file types the prop accepts. Empty for `video`, which is never a file. */
  types: readonly AssetType[];
  /** A URL on a media origin is accepted too (`Video.captions`, `Video.poster`). */
  mediaUrl: boolean;
};

const image: ReferenceRule = { kind: "image", types: IMAGE_TYPES, mediaUrl: false };

/**
 * The props of the components that refer to a file in assets/ or to a media URL, by component and prop.
 * A Markdown link, a `CodeSteps` prop, and a `Diagram` `source` are not here. Both the checks and
 * `rewriteAssetUrls` read this table.
 */
export const REFERENCE_PROPS: Readonly<Record<string, Readonly<Record<string, ReferenceRule>>>> = {
  Image: { src: image },
  Diagram: { src: { kind: "svg", types: ["svg"], mediaUrl: false } },
  Model3D: { src: { kind: "model", types: MODEL_TYPES, mediaUrl: false }, poster: image },
  Video: {
    src: { kind: "video", types: [], mediaUrl: true },
    captions: { kind: "captions", types: ["vtt"], mediaUrl: true },
    poster: { ...image, mediaUrl: true },
  },
};

/** The rule for a Markdown image `![alt](path)`. */
export const MARKDOWN_IMAGE_RULE: ReferenceRule = image;

/** The `component` and `prop` of a Markdown image in a reference. */
export const MARKDOWN_IMAGE = { component: "Markdown", prop: "image" } as const;

export function referenceRule(component: string, prop: string): ReferenceRule | undefined {
  if (component === MARKDOWN_IMAGE.component && prop === MARKDOWN_IMAGE.prop) return MARKDOWN_IMAGE_RULE;
  const props = Object.hasOwn(REFERENCE_PROPS, component) ? REFERENCE_PROPS[component] : undefined;
  return props !== undefined && Object.hasOwn(props, prop) ? props[prop] : undefined;
}

/** A reference to an asset or a media file that a lesson makes, with the position of the prop or the Markdown image. */
export type LessonReference = {
  /** The component name, or `Markdown` for a Markdown image. */
  component: string;
  /** The prop name, or `image` for a Markdown image. */
  prop: string;
  /** The value as the author wrote it. */
  value: string;
  line: number;
  column: number;
};

/** A value is an asset path when it has no scheme; a value with a scheme is a URL. */
export function isUrl(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

/** The lowercase extension of a file name without the dot, or "" when it has none. A leading dot is not an extension. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** `<stem>-<first 16 hex digits of the SHA-256>.<ext>`, the flat name of a file in the public build. */
export function hashedName(name: string, sha256: string): string {
  const dot = name.lastIndexOf(".");
  return `${name.slice(0, dot)}-${sha256.slice(0, 16)}.${name.slice(dot + 1).toLowerCase()}`;
}

/** The URL of a hashed asset that the backend serves (#58). */
export function assetUrl(courseId: string, file: string): string {
  return `/api/courses/${courseId}/assets/${file}`;
}
