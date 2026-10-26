/**
 * Which `Video` sources are an embed player (an `<iframe>`) and which are a file (a `<video>`).
 * The rules are the `embeds` of `content-build/media-config.json`, the one list that the content
 * build checks and that the Content-Security-Policy is generated from (`frontend/scripts/csp.mjs`).
 * Only `embeds` is imported, so no other key is part of the bundle.
 */
import { embeds } from "../../../content-build/media-config.json";

export interface EmbedRule {
  origin: string;
  pathPrefix: string;
}

export const EMBED_RULES: readonly EmbedRule[] = embeds.map(({ origin, pathPrefix }) => ({ origin, pathPrefix }));

/** The names a player takes to start playing by itself. The design system says never autoplay. */
const AUTOPLAY = "autoplay";

function parameterName(pair: string): string {
  const name = pair.split("=", 1)[0].replace(/\+/g, " ");
  try {
    return decodeURIComponent(name).toLowerCase();
  } catch {
    return name.toLowerCase();
  }
}

/**
 * The `src` for an `<iframe>` when `url` is on an embed rule's origin and path, else null. A
 * `?autoplay=...` parameter is removed (in any letter case); every other query parameter, and the
 * rest of the URL, stays as written.
 */
export function embedSource(url: URL, rules: readonly EmbedRule[] = EMBED_RULES): string | null {
  if (!rules.some((rule) => url.origin === rule.origin && url.pathname.startsWith(rule.pathPrefix))) return null;
  const kept = url.search
    .slice(1)
    .split("&")
    .filter((pair) => pair !== "" && parameterName(pair) !== AUTOPLAY);
  return `${url.origin}${url.pathname}${kept.length > 0 ? `?${kept.join("&")}` : ""}${url.hash}`;
}
