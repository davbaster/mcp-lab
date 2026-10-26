import { useState, type SyntheticEvent } from "react";
import { Unavailable } from "./Unavailable";
import { embedSource } from "./embeds";
import { checkVideoProps } from "./props";
import type { ContentComponentProps } from "./tree";

/** What an embed player may do: nothing else, so never `autoplay`. */
const IFRAME_ALLOW = "fullscreen; picture-in-picture; encrypted-media";

/** True when the captions file is on another origin than this page, where the browser needs CORS. */
function isCrossOrigin(url: string): boolean {
  return new URL(url, window.location.href).origin !== window.location.origin;
}

/**
 * A video file on a media origin. The native controls make it keyboard-operable; it never
 * autoplays or loops, and loads only its metadata until the learner plays it. If the file does not
 * load (it is missing, or the Content-Security-Policy blocks its origin), a box takes its place.
 * A captions file that does not load (`error` on the `<track>`) leaves the video alone.
 */
function VideoFile({
  src,
  title,
  captions,
  poster,
}: {
  src: string;
  title: string;
  captions: string | null;
  poster: string | null;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (failedSrc === src) return <div className="media-fallback">This video could not be loaded.</div>;
  return (
    <div className="media-frame">
      <video
        controls
        preload="metadata"
        src={src}
        poster={poster ?? undefined}
        aria-label={title}
        // A cross-origin <track> is ignored without it. It is set only for that case, so a CDN that
        // sends no CORS headers still plays the video.
        crossOrigin={captions !== null && isCrossOrigin(captions) ? "anonymous" : undefined}
        onError={(event: SyntheticEvent<HTMLVideoElement>) => {
          // An error on a <track> does not bubble, but the check keeps it that way.
          if (event.target === event.currentTarget) setFailedSrc(src);
        }}
      >
        {captions !== null && <track kind="captions" srcLang="en" label="English" default src={captions} />}
      </video>
    </div>
  );
}

/** The `Video` component: a file on a media origin (`<video>`), or a listed embed (`<iframe>`). */
export function VideoBlock({ name, props }: ContentComponentProps) {
  const checked = checkVideoProps(props);
  if (!checked.ok) return <Unavailable name={name} problem={checked.problem} />;
  const { src, title, captions, poster } = checked.value;

  // `captions` and `poster` do not apply to a player inside an iframe, so they are ignored.
  const embed = embedSource(src);
  if (embed !== null) {
    return (
      <div className="video">
        <div className="media-frame">
          <iframe
            src={embed}
            title={title}
            loading="lazy"
            allow={IFRAME_ALLOW}
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>
      </div>
    );
  }
  return (
    <div className="video">
      <VideoFile src={src.href} title={title} captions={captions} poster={poster} />
    </div>
  );
}
