// Where a media URL may point: a media CDN origin, or an embed player, as media-config.json lists them.
// The decision uses the parsed `origin` and `pathname` (never a string prefix of the raw value).

import { IMAGE_TYPES } from "./assets.ts";
import type { MediaConfig } from "./media-config.ts";

export type UrlUse = "video" | "captions" | "poster";

/** The parts of a media URL that the checks need. */
export type MediaUrl = { url: URL };

const CONTROL_OR_SPACE = /[\s\p{Cc}]/u;

/** A space, a control character, or a backslash in the value as written. */
function rawProblem(value: string): string | undefined {
  if (CONTROL_OR_SPACE.test(value)) return "the URL has a space or a control character";
  return value.includes("\\") ? "the URL has a backslash" : undefined;
}

/**
 * Parses an absolute `https` media URL. Returns the URL, or why `value` is not acceptable before the
 * origin is even looked at: spaces, control characters, a backslash, credentials (`user@`), another
 * scheme than https, or text that is not a URL.
 */
export function parseMediaUrl(value: string): MediaUrl | { problem: string } {
  const raw = rawProblem(value);
  if (raw !== undefined) return { problem: raw };
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(value)?.[1];
  if (authority?.includes("@") === true) return { problem: "the URL has credentials (`user@`), which are not allowed" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { problem: "the URL is not a valid address" };
  }
  if (url.username !== "" || url.password !== "") return { problem: "the URL has credentials (`user@`), which are not allowed" };
  if (url.protocol !== "https:") return { problem: `the URL must start with https:// (it uses \`${url.protocol}\`)` };
  return { url };
}

/**
 * Why the value of a `Video` prop (`src`, `captions`, or `poster`) that is an absolute URL, or a relative
 * value, may not be used; undefined when it may. `captions` and `poster` take a URL on a media origin
 * only (not an embed), with a `.vtt` or an image file name.
 */
export function mediaUrlProblem(value: string, use: UrlUse, config: MediaConfig): string | undefined {
  const shown = `\`${value}\``;
  const raw = rawProblem(value);
  if (raw !== undefined) return `${shown}: ${raw}`;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    return use === "video"
      ? `${shown} is not an absolute URL; videos are not served from assets/, so use a https URL on a media CDN or an embed URL`
      : `${shown} is not an asset path or an https URL`;
  }
  const parsed = parseMediaUrl(value);
  if ("problem" in parsed) return `${shown}: ${parsed.problem}`;
  const { url } = parsed;

  if (config.mediaOrigins.includes(url.origin)) {
    return use === "video" ? undefined : fileNameProblem(shown, url, use);
  }
  const embed = config.embeds.find((rule) => rule.origin === url.origin);
  if (embed !== undefined) {
    if (use !== "video") return `${shown}: an embed player cannot serve a ${use === "captions" ? "captions file" : "poster image"}; use a file on a media origin or in assets/`;
    const id = url.pathname.startsWith(embed.pathPrefix) ? url.pathname.slice(embed.pathPrefix.length) : "";
    if (id !== "" && !id.includes("/") && new RegExp(embed.idPattern).test(id)) return undefined;
    return `${shown}: an address on ${embed.origin} must be ${embed.origin}${embed.pathPrefix}<id>, with an ID that matches ${embed.idPattern}`;
  }
  const watch = config.embeds.find((rule) => rule.watchHosts.includes(url.hostname));
  if (watch !== undefined) {
    return `${shown} is a watch page, which cannot be embedded; use \`${watch.origin}${watch.pathPrefix}<id>\``;
  }
  return `${shown}: the origin ${url.origin} is not in media-config.json; add it there (a reviewed change) or use an allowed origin`;
}

/** A captions URL must end in `.vtt`, and a poster URL in an image extension; the query is ignored. */
function fileNameProblem(shown: string, url: URL, use: "captions" | "poster"): string | undefined {
  const path = url.pathname.toLowerCase();
  if (use === "captions") {
    return path.endsWith(".vtt") ? undefined : `${shown}: the URL of a captions file must end in .vtt`;
  }
  return IMAGE_TYPES.some((type) => path.endsWith(`.${type}`))
    ? undefined
    : `${shown}: the URL of a poster must end in ${IMAGE_TYPES.map((type) => `.${type}`).join(", ")}`;
}
