import { useState } from "react";
import { Unavailable } from "./Unavailable";
import { checkMediaProps } from "./props";
import type { ContentComponentProps } from "./tree";

/**
 * The `Diagram` component. The SVG is shown through an `<img>`, never inline, in an `<object>` or
 * in an `<iframe>`, so a script inside the file can never run.
 */
export function DiagramBlock({ name, props }: ContentComponentProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const checked = checkMediaProps(props);
  if (!checked.ok) return <Unavailable name={name} problem={checked.problem} />;
  const { src, alt } = checked.value;

  if (failedSrc === src) return <div className="media-fallback diagram">{alt}</div>;
  return (
    <figure className="diagram">
      <img className="lesson-image" src={src} alt={alt} loading="lazy" onError={() => setFailedSrc(src)} />
      <figcaption>
        <a className="link-action" href={src} target="_blank" rel="noopener noreferrer">
          View full size
        </a>
      </figcaption>
    </figure>
  );
}
