import { useState } from "react";
import { Unavailable } from "./Unavailable";
import { checkMediaProps } from "./props";
import type { ContentComponentProps } from "./tree";

/**
 * An `<img>` that falls back to its alt text if the file does not load, so the learner can still
 * read what it says. Used by the `Image` component (a box) and by Markdown images (inline text).
 */
export function LessonImage({
  src,
  alt,
  title,
  block,
}: {
  src: string;
  alt: string;
  title?: string;
  /** A box for the `Image` component; inline text for an image inside a paragraph. */
  block: boolean;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (failedSrc === src) {
    if (block) return <div className="media-fallback">{alt}</div>;
    return alt === "" ? null : <span className="media-fallback media-fallback-inline">{alt}</span>;
  }
  return (
    <img
      className="lesson-image"
      src={src}
      alt={alt}
      title={title}
      loading="lazy"
      onError={() => setFailedSrc(src)}
    />
  );
}

/** The `Image` component. */
export function ImageBlock({ name, props }: ContentComponentProps) {
  const checked = checkMediaProps(props);
  if (!checked.ok) return <Unavailable name={name} problem={checked.problem} />;
  return (
    <div className="lesson-figure">
      <LessonImage src={checked.value.src} alt={checked.value.alt} block />
    </div>
  );
}
