// media-config.json: the only list of media origins and size limits.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { SetupError } from "../src/component-schemas.ts";
import { DEFAULT_MEDIA_CONFIG, loadMediaConfig } from "../src/media-config.ts";
import { VALID_COURSE, PART_DIR, temporaryFolder } from "./helpers.ts";
import { mediaConfigFile } from "./asset-helpers.ts";

const config = JSON.parse(readFileSync(join(PART_DIR, "media-config.json"), "utf8")) as {
  mediaOrigins: string[];
  embeds: { origin: string; pathPrefix: string; idPattern: string; watchHosts: string[] }[];
  assetLimits: Record<string, number>;
};

function load(changes: Record<string, unknown>) {
  return () => loadMediaConfig(mediaConfigFile(changes));
}

describe("the committed media-config.json", () => {
  it("lists the placeholder CDN, YouTube and Vimeo, and the three limits (MiB)", () => {
    expect(loadMediaConfig()).toEqual({
      mediaOrigins: ["https://media.mcp-lab.example"],
      embeds: [
        {
          origin: "https://www.youtube-nocookie.com",
          pathPrefix: "/embed/",
          idPattern: "^[A-Za-z0-9_-]+$",
          watchHosts: ["www.youtube.com", "youtube.com", "m.youtube.com", "youtu.be"],
        },
        { origin: "https://player.vimeo.com", pathPrefix: "/video/", idPattern: "^[0-9]+$", watchHosts: ["vimeo.com", "www.vimeo.com"] },
      ],
      assetLimits: { imageBytes: 5 * 1024 * 1024, modelBytes: 25 * 1024 * 1024, captionBytes: 1024 * 1024 },
    });
  });

  it("is found from the source file, not from the working folder", () => {
    expect(DEFAULT_MEDIA_CONFIG).toBe(join(PART_DIR, "media-config.json"));
    const result = spawnSync(process.execPath, [join(PART_DIR, "src", "validate.ts"), VALID_COURSE], { cwd: temporaryFolder(), encoding: "utf8" });

    expect(result.stdout).toBe("0 error(s), 0 warning(s)\n");
    expect(result.status).toBe(0);
  });

  it("has a draft-07 schema that forbids extra keys at every level", () => {
    const schema = JSON.parse(readFileSync(join(PART_DIR, "schemas", "media-config.schema.json"), "utf8"));
    const objects: { additionalProperties?: unknown }[] = [schema, schema.properties.embeds.items, schema.properties.assetLimits];

    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    for (const object of objects) expect(object.additionalProperties).toBe(false);
  });

  it("is not copied into src/: no source file contains a media origin or host", () => {
    const needles = [
      ...config.mediaOrigins,
      ...config.embeds.flatMap((embed) => [embed.origin, ...embed.watchHosts]),
    ].flatMap((value) => [value, new URL(value.includes("://") ? value : `https://${value}`).hostname]);
    const sources = readdirSync(join(PART_DIR, "src")).filter((name) => name.endsWith(".ts"));

    expect(sources.length).toBeGreaterThan(10);
    expect(needles.length).toBeGreaterThan(8);
    for (const name of sources) {
      const text = readFileSync(join(PART_DIR, "src", name), "utf8").toLowerCase();
      for (const needle of needles) expect(text.includes(needle.toLowerCase()), `${name} contains ${needle}`).toBe(false);
    }
  });
});

describe("a media config that is not valid", () => {
  const bad = (host: string) => `https://${host}`;
  const embed = (changes: Record<string, unknown> = {}) => ({ ...config.embeds[0], ...changes });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ["a missing key", { mediaOrigins: undefined }, /media-config\.json: `?the file`? must have required property 'mediaOrigins'/],
    ["an unknown key", { extra: 1 }, /media-config\.json: the file must NOT have additional properties \(unknown key `extra`\)/],
    ["an origin that is not a string", { mediaOrigins: [1] }, /media-config\.json: `mediaOrigins\[0\]` must be string/],
    ["an http origin", { mediaOrigins: ["http://cdn.test"] }, /`mediaOrigins\[0\]`.*https:\/\//],
    ["an origin that is not a URL", { mediaOrigins: ["https://"] }, /`mediaOrigins\[0\]` is not a URL/],
    ["an origin with a path", { mediaOrigins: ["https://cdn.test/media"] }, /`mediaOrigins\[0\]` must be written exactly as https:\/\/cdn\.test/],
    ["an origin with a trailing slash", { mediaOrigins: ["https://cdn.test/"] }, /`mediaOrigins\[0\]` must be written exactly as https:\/\/cdn\.test/],
    ["an origin in capital letters", { mediaOrigins: ["https://CDN.test"] }, /`mediaOrigins\[0\]` must be written exactly as https:\/\/cdn\.test/],
    ["an origin with a default port", { mediaOrigins: ["https://cdn.test:443"] }, /`mediaOrigins\[0\]` must be written exactly as https:\/\/cdn\.test/],
    ["an origin with credentials", { mediaOrigins: ["https://user@cdn.test"] }, /`mediaOrigins\[0\]` must be written exactly as https:\/\/cdn\.test/],
    ["a wildcard origin", { mediaOrigins: ["https://*.cdn.test"] }, /`mediaOrigins\[0\]` must have a host of lowercase letters, digits, dots, and hyphens, so no wildcard \(got "https:\/\/\*\.cdn\.test"\)/],
    ["a repeated origin", { mediaOrigins: ["https://cdn.test", "https://cdn.test"] }, /`mediaOrigins\[1\]` repeats the origin "https:\/\/cdn\.test"/],
    ["an embed origin that is also a media origin", { mediaOrigins: ["https://player.vimeo.com"] }, /`embeds\[1\]\.origin` repeats the origin/],
    ["a repeated embed origin", { embeds: [embed(), embed()] }, /`embeds\[1\]\.origin` repeats the origin/],
    ["an embed with an http origin", { embeds: [embed({ origin: bad("x.test").replace("https", "http") })] }, /`embeds\[0\]\.origin`.*https:\/\//],
    ["an embed with an unknown key", { embeds: [embed({ extra: 1 })] }, /`embeds\[0\]` must NOT have additional properties \(unknown key `extra`\)/],
    ["an embed without a path prefix", { embeds: [embed({ pathPrefix: undefined })] }, /`embeds\[0\]` must have required property 'pathPrefix'/],
    ["a path prefix without slashes", { embeds: [embed({ pathPrefix: "embed" })] }, /`embeds\[0\]\.pathPrefix` must match pattern/],
    ["an ID pattern that is not anchored", { embeds: [embed({ idPattern: "[0-9]+" })] }, /`embeds\[0\]\.idPattern` must start with \^ and end with \$/],
    ["an ID pattern that is not a regular expression", { embeds: [embed({ idPattern: "^(a$" })] }, /`embeds\[0\]\.idPattern` is not a valid regular expression/],
    ["a watch host with a scheme", { embeds: [embed({ watchHosts: ["https://youtu.test"] })] }, /`embeds\[0\]\.watchHosts\[0\]` must be a lowercase host name/],
    ["a watch host in capital letters", { embeds: [embed({ watchHosts: ["YouTu.test"] })] }, /`embeds\[0\]\.watchHosts\[0\]` must be a lowercase host name/],
    ["a repeated watch host", { embeds: [embed({ watchHosts: ["a.test", "a.test"] })] }, /`embeds\[0\]\.watchHosts\[1\]` repeats the host "a\.test"/],
    ["a limit of zero", { assetLimits: { ...config.assetLimits, imageBytes: 0 } }, /`assetLimits\.imageBytes` must be >= 1/],
    ["a limit that is not a whole number", { assetLimits: { ...config.assetLimits, modelBytes: 1.5 } }, /`assetLimits\.modelBytes` must be integer/],
    ["a limit that is a string", { assetLimits: { ...config.assetLimits, captionBytes: "1" } }, /`assetLimits\.captionBytes` must be integer/],
    ["a missing limit", { assetLimits: { imageBytes: 1, modelBytes: 1 } }, /`assetLimits` must have required property 'captionBytes'/],
  ])("throws a SetupError naming the file and the key for %s", (_name, changes, message) => {
    // JSON.stringify leaves out a key whose value is undefined, so `undefined` below means "missing".
    const path = mediaConfigFile(changes);

    expect(() => loadMediaConfig(path)).toThrow(SetupError);
    expect(() => loadMediaConfig(path)).toThrow(message);
    expect(() => loadMediaConfig(path)).toThrow(/^media-config\.json: /);
  });

  it("throws a SetupError for a file that is not JSON, or that is missing", () => {
    const path = join(temporaryFolder(), "media-config.json");
    writeFileSync(path, "{");

    expect(() => loadMediaConfig(path)).toThrow(SetupError);
    expect(() => loadMediaConfig(path)).toThrow(/^media-config\.json: the file is not valid JSON/);
    expect(() => loadMediaConfig(join(temporaryFolder(), "media-config.json"))).toThrow(/^media-config\.json: the file cannot be read/);
  });

  it("accepts the origin exactly as new URL(origin).origin writes it", () => {
    expect(load({ mediaOrigins: ["https://cdn.test", "https://cdn.test:8443", "https://a.b.test"] })().mediaOrigins).toHaveLength(3);
  });

  it("is a build setup error for `validate`: it prints the message and exits 3", () => {
    let stderr = "";
    let stdout = "";
    const code = main([VALID_COURSE], { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) }, { mediaConfigPath: mediaConfigFile({ mediaOrigins: ["http://cdn.test"] }) });

    expect(code).toBe(3);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/^build setup error: media-config\.json: `mediaOrigins\[0\]` must start with https:\/\/ \(got "http:\/\/cdn\.test"\)\n$/);
  });
});
