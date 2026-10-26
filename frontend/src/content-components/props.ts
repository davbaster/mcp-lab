/**
 * Checks a component's props against what its schema in `schemas/` says. Each component calls
 * its check and shows the "can't be shown" box when it fails. A prop the schema does not list is
 * ignored; a listed prop with a wrong value is a failure, like a missing required one.
 */
import { isFilled, type Props } from "./tree";
import { httpsUrl, siteOrHttpsSource, siteSource } from "./urls";

export type Checked<T> = { ok: true; value: T } | { ok: false; problem: string };

const ok = <T>(value: T): Checked<T> => ({ ok: true, value });
const fail = (problem: string): Checked<never> => ({ ok: false, problem });

/** Own properties only, so `props.constructor` or `__proto__` is never read as a value. */
function own(props: Props, key: string): unknown {
  return Object.hasOwn(props, key) ? props[key] : undefined;
}

/**
 * `Image` and `Diagram` need the same two props. A `Diagram` with only `source` (Mermaid text)
 * fails: the build turns `source` into `src`, so a lesson that still has it was not built.
 */
export function checkMediaProps(props: Props): Checked<{ src: string; alt: string }> {
  const alt = own(props, "alt");
  if (!isFilled(alt)) return fail("alt is missing or empty");
  const src = siteSource(own(props, "src"));
  if (src === null) return fail("src is missing or is not a path on this site");
  return ok({ src, alt });
}

export const CALLOUT_TYPES = ["tip", "warning", "note"] as const;
export type CalloutType = (typeof CALLOUT_TYPES)[number];

export function checkCalloutProps(props: Props): Checked<{ type: CalloutType; title: string | null }> {
  const type = own(props, "type");
  const known = CALLOUT_TYPES.find((candidate) => candidate === type);
  if (!known) return fail("type is not one of tip, warning, note");
  const title = own(props, "title");
  if (title !== undefined && !isFilled(title)) return fail("title is empty");
  return ok({ type: known, title: title ?? null });
}

export function checkTabProps(props: Props): Checked<{ label: string }> {
  const label = own(props, "label");
  return isFilled(label) ? ok({ label }) : fail("label is missing or empty");
}

const STEP_NUMBER = /^[1-9][0-9]*$/;

/** `step` is a whole number of 1 or more written as a string; `file`, when given, is not empty. */
export function checkCodeStepsProps(props: Props): Checked<{ step: number; file: string | null }> {
  const step = own(props, "step");
  if (typeof step !== "string" || !STEP_NUMBER.test(step) || !Number.isSafeInteger(Number(step))) {
    return fail("step is not a whole number of 1 or more written as a string");
  }
  const file = own(props, "file");
  if (file !== undefined && (typeof file !== "string" || file === "")) return fail("file is empty");
  return ok({ step: Number(step), file: file ?? null });
}

/**
 * `Video`: `title` is filled; `src` is an `https` URL (a file on a media origin, or an embed
 * player: `VideoBlock` decides which); `captions` and `poster`, when present, are a path on this
 * site or an `https` URL. Anything else is a failure that names the prop.
 */
export function checkVideoProps(props: Props): Checked<{ src: URL; title: string; captions: string | null; poster: string | null }> {
  const title = own(props, "title");
  if (!isFilled(title)) return fail("title is missing or empty");
  const src = httpsUrl(own(props, "src"));
  if (src === null) return fail("src is missing or is not an https URL");
  const optional = (key: "captions" | "poster"): Checked<string | null> => {
    const value = own(props, key);
    if (value === undefined) return ok(null);
    const source = siteOrHttpsSource(value);
    return source === null ? fail(`${key} is not a path on this site or an https URL`) : ok(source);
  };
  const captions = optional("captions");
  if (!captions.ok) return captions;
  const poster = optional("poster");
  if (!poster.ok) return poster;
  return ok({ src, title, captions: captions.value, poster: poster.value });
}

/** `Model3D`: `alt` is filled; `src` and `poster` are paths on this site (the build puts them there). */
export function checkModel3DProps(props: Props): Checked<{ src: string; alt: string; poster: string }> {
  const alt = own(props, "alt");
  if (!isFilled(alt)) return fail("alt is missing or empty");
  const src = siteSource(own(props, "src"));
  if (src === null) return fail("src is missing or is not a path on this site");
  const poster = siteSource(own(props, "poster"));
  if (poster === null) return fail("poster is missing or is not a path on this site");
  return ok({ src, alt, poster });
}
