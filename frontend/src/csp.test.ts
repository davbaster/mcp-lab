import { describe, expect, it } from "vitest";
import realConfig from "../../content-build/media-config.json";
import nginxConf from "../nginx.conf?raw";
import { buildCsp, CspError, generate, nginxInclude, run } from "../scripts/csp.mjs";
import scriptSource from "../scripts/csp.mjs?raw";

/** A fixture allowlist: the real file is never the input of the exact-value tests. */
const fixture = {
  mediaOrigins: ["https://cdn-one.test", "https://cdn-two.test:8443"],
  embeds: [
    { origin: "https://player-one.test", pathPrefix: "/embed/", idPattern: "^[a-z]+$", watchHosts: ["one.test"] },
    { origin: "https://player-two.test", pathPrefix: "/v/", idPattern: "^[0-9]+$", watchHosts: ["two.test"] },
  ],
  assetLimits: { imageBytes: 1, modelBytes: 1, captionBytes: 1 },
};

/** The directives of a header value, in order, as `[name, sources]`. */
function directives(csp: string): [string, string][] {
  return csp.split("; ").map((part) => {
    const [name, ...sources] = part.split(" ");
    return [name, sources.join(" ")];
  });
}

describe("buildCsp, for a fixture allowlist", () => {
  it("has exactly these directives, in this order, with these sources", () => {
    expect(directives(buildCsp(fixture))).toEqual([
      ["default-src", "'self'"],
      ["script-src", "'self'"],
      ["style-src", "'self' 'unsafe-inline'"],
      ["img-src", "'self' data: blob: https://cdn-one.test https://cdn-two.test:8443"],
      ["media-src", "'self' https://cdn-one.test https://cdn-two.test:8443"],
      ["frame-src", "https://player-one.test https://player-two.test"],
      ["connect-src", "'self'"],
      ["object-src", "'none'"],
      ["base-uri", "'self'"],
      ["form-action", "'self'"],
      ["frame-ancestors", "'none'"],
    ]);
  });

  it("is the whole header as one string", () => {
    expect(buildCsp(fixture)).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob: https://cdn-one.test https://cdn-two.test:8443; " +
        "media-src 'self' https://cdn-one.test https://cdn-two.test:8443; " +
        "frame-src https://player-one.test https://player-two.test; connect-src 'self'; object-src 'none'; " +
        "base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    );
  });

  it("adds no extra source to img-src and media-src when mediaOrigins is empty", () => {
    const csp = directives(buildCsp({ ...fixture, mediaOrigins: [] }));
    expect(csp).toContainEqual(["img-src", "'self' data: blob:"]);
    expect(csp).toContainEqual(["media-src", "'self'"]);
    expect(csp).toContainEqual(["frame-src", "https://player-one.test https://player-two.test"]);
  });

  it("uses frame-src 'none' when embeds is empty, never an empty frame-src", () => {
    const csp = buildCsp({ ...fixture, embeds: [] });
    expect(directives(csp)).toContainEqual(["frame-src", "'none'"]);
    expect(csp).not.toMatch(/frame-src(;|$)/);
    expect(directives(csp)).toContainEqual(["img-src", "'self' data: blob: https://cdn-one.test https://cdn-two.test:8443"]);
  });

  it("works with both lists empty", () => {
    const csp = directives(buildCsp({ ...fixture, mediaOrigins: [], embeds: [] }));
    expect(csp).toContainEqual(["img-src", "'self' data: blob:"]);
    expect(csp).toContainEqual(["media-src", "'self'"]);
    expect(csp).toContainEqual(["frame-src", "'none'"]);
  });

  it("lists a repeated origin once", () => {
    const csp = directives(buildCsp({ ...fixture, mediaOrigins: ["https://cdn-one.test", "https://cdn-one.test"] }));
    expect(csp).toContainEqual(["media-src", "'self' https://cdn-one.test"]);
  });

  it("has no unsafe-eval, wasm-unsafe-eval, wildcard, or http: or https: scheme source", () => {
    const csp = buildCsp(fixture);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("'wasm-unsafe-eval'");
    expect(csp).not.toContain("*");
    expect(csp).not.toMatch(/(^|\s)https?:(\s|;|$)/);
    // 'unsafe-inline' is only for styles; scripts stay 'self'.
    expect(directives(csp).filter(([, sources]) => sources.includes("'unsafe-inline'"))).toEqual([["style-src", "'self' 'unsafe-inline'"]]);
  });

  it("does not read any other key of the config", () => {
    const withOthers = { ...fixture, assetLimits: { imageBytes: 99 }, extra: ["https://not-used.test"] };
    expect(buildCsp(withOthers)).toBe(buildCsp(fixture));
  });
});

describe("buildCsp refuses a value that is not exactly the origin of an https URL", () => {
  const bad: [string, string][] = [
    ["http origin", "http://cdn.test"],
    ["a path", "https://cdn.test/videos"],
    ["a trailing slash", "https://cdn.test/"],
    ["a semicolon", "https://cdn.test; script-src *"],
    ["a semicolon in the host", "https://cdn;test.example"],
    ["a single quote", "https://cdn'.test"],
    ["a double quote", 'https://cdn".test'],
    ["a space", "https://cdn.test other.test"],
    ["a newline", "https://cdn.test\nscript-src *"],
    ["a carriage return", "https://cdn.test\r"],
    ["a tab", "https://cdn.test\t"],
    ["a dollar sign (an nginx variable)", "https://cdn$host.test"],
    ["a backslash", "https://cdn\\.test"],
    ["a wildcard", "https://*.cdn.test"],
    ["a wildcard host", "https://*"],
    ["credentials", "https://user:pw@cdn.test"],
    ["a user name", "https://user@cdn.test"],
    ["an upper-case host", "https://CDN.test"],
    ["the default port", "https://cdn.test:443"],
    ["a query", "https://cdn.test?x=1"],
    ["a fragment", "https://cdn.test#x"],
    ["a data: scheme", "data:"],
    ["a bare scheme", "https:"],
    ["a scheme-relative value", "//cdn.test"],
    ["a bare host", "cdn.test"],
    ["an empty string", ""],
    ["a CSP keyword", "'unsafe-eval'"],
    ["a non-ASCII host", "https://cdn-é.test"],
  ];

  it.each(bad)("in mediaOrigins: %s", (_name, value) => {
    expect(() => buildCsp({ ...fixture, mediaOrigins: ["https://cdn-one.test", value] })).toThrow(CspError);
    expect(() => buildCsp({ ...fixture, mediaOrigins: ["https://cdn-one.test", value] })).toThrow(/mediaOrigins\[1\]/);
  });

  it.each(bad)("in an embeds origin: %s", (_name, value) => {
    const embeds = [fixture.embeds[0], { ...fixture.embeds[1], origin: value }];
    expect(() => buildCsp({ ...fixture, embeds })).toThrow(/embeds\[1\]\.origin/);
  });

  it.each([null, 3, true, {}, ["https://cdn.test"]])("refuses an origin that is not a string: %j", (value) => {
    expect(() => buildCsp({ ...fixture, mediaOrigins: [value] })).toThrow(/mediaOrigins\[0\]/);
  });

  it("names the value in the message", () => {
    expect(() => buildCsp({ ...fixture, mediaOrigins: ["https://a.test; x"] })).toThrow('got "https://a.test; x"');
  });

  it.each([
    ["no mediaOrigins", { embeds: [] }, /mediaOrigins must be a list/],
    ["mediaOrigins that is not a list", { mediaOrigins: "https://cdn.test", embeds: [] }, /mediaOrigins must be a list/],
    ["no embeds", { mediaOrigins: [] }, /embeds must be a list/],
    ["an embed that is not an object", { mediaOrigins: [], embeds: ["https://player.test"] }, /embeds\[0\]\.origin/],
    ["an embed without an origin", { mediaOrigins: [], embeds: [{ pathPrefix: "/e/" }] }, /embeds\[0\]\.origin/],
    ["a config that is a list", [], /must be an object/],
    ["a config that is null", null, /must be an object/],
  ])("refuses %s", (_name, config, message) => {
    expect(() => buildCsp(config)).toThrow(message);
  });
});

describe("nginxInclude", () => {
  it("sets the header once, with always", () => {
    const include = nginxInclude(buildCsp(fixture));
    expect(include.match(/^add_header /gm)).toHaveLength(1);
    expect(include).toMatch(/^add_header Content-Security-Policy "[^"]+" always;$/m);
    expect(include.endsWith("\n")).toBe(true);
  });

  it.each(['a"b', "a$b", "a\\b", "a\nb", "a\rb"])("refuses a policy with %j", (value) => {
    expect(() => nginxInclude(value)).toThrow(CspError);
  });
});

describe("the script", () => {
  /** A disk in memory: the files by path, and what was printed. */
  function disk(files: Record<string, string>) {
    const written: Record<string, string> = {};
    const printed: string[] = [];
    const io = {
      readFile: (path: string) => {
        if (!(path in files)) throw new Error("ENOENT");
        return files[path];
      },
      writeFile: (path: string, text: string) => {
        written[path] = text;
      },
      error: (message: string) => printed.push(message),
    };
    return { io, written, printed };
  }
  const configFile = "../content-build/media-config.json";
  const valid = JSON.stringify(fixture);

  it("writes the include file for a config and exits with 0", () => {
    const { io, written, printed } = disk({ [configFile]: valid });
    expect(run([configFile, "csp.conf"], io)).toBe(0);
    expect(written).toEqual({ "csp.conf": nginxInclude(buildCsp(fixture)) });
    expect(printed).toEqual([]);
  });

  it("generate() returns the include for the text of a config", () => {
    expect(generate(valid, "media-config.json")).toBe(nginxInclude(buildCsp(fixture)));
  });

  it("exits with 1, names the file and the key, and writes nothing, for a bad origin", () => {
    const { io, written, printed } = disk({ [configFile]: JSON.stringify({ ...fixture, mediaOrigins: ["https://cdn.test; script-src *"] }) });
    expect(run([configFile, "csp.conf"], io)).toBe(1);
    expect(written).toEqual({});
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain("media-config.json: mediaOrigins[0]");
  });

  it("names embeds[0].origin for a bad embed origin", () => {
    const { io, printed } = disk({ [configFile]: JSON.stringify({ ...fixture, embeds: [{ origin: "https://player.test/embed" }] }) });
    expect(run([configFile, "csp.conf"], io)).toBe(1);
    expect(printed[0]).toContain("embeds[0].origin");
  });

  it.each([
    ["a file that is not JSON", "{ not json"],
    ["an empty file", ""],
  ])("exits with 1 for %s", (_name, content) => {
    const { io, written, printed } = disk({ [configFile]: content });
    expect(run([configFile, "csp.conf"], io)).toBe(1);
    expect(written).toEqual({});
    expect(printed[0]).toContain("media-config.json: the file is not valid JSON");
  });

  it("exits with 1 for a file that cannot be read", () => {
    const { io, written, printed } = disk({});
    expect(run([configFile, "csp.conf"], io)).toBe(1);
    expect(written).toEqual({});
    expect(printed[0]).toContain("media-config.json: the file cannot be read");
  });

  it("reads a file with a byte order mark", () => {
    const { io } = disk({ [configFile]: `\uFEFF${valid}` });
    expect(run([configFile, "csp.conf"], io)).toBe(0);
  });

  it.each([[[]], [["only-one"]], [["a", "b", "c"]]])("exits with 2 and explains the usage for the arguments %j", (args) => {
    const { io, written, printed } = disk({});
    expect(run(args, io)).toBe(2);
    expect(written).toEqual({});
    expect(printed[0]).toContain("Usage");
  });
});

describe("the committed config and nginx.conf", () => {
  it("make a valid header with every directive and the origins of media-config.json", () => {
    const csp = buildCsp(realConfig);
    const found = Object.fromEntries(directives(csp));

    expect(Object.keys(found)).toEqual([
      "default-src",
      "script-src",
      "style-src",
      "img-src",
      "media-src",
      "frame-src",
      "connect-src",
      "object-src",
      "base-uri",
      "form-action",
      "frame-ancestors",
    ]);
    expect(found["img-src"]).toBe(["'self' data: blob:", ...realConfig.mediaOrigins].join(" "));
    expect(found["media-src"]).toBe(["'self'", ...realConfig.mediaOrigins].join(" "));
    expect(found["frame-src"]).toBe(realConfig.embeds.map((embed) => embed.origin).join(" "));
    expect(csp).not.toMatch(/unsafe-eval|\*/);
  });

  it("leave no origin written by hand in nginx.conf or in the frontend scripts", () => {
    const sources = [nginxConf, scriptSource];
    const origins = [...realConfig.mediaOrigins, ...realConfig.embeds.map((embed) => embed.origin)];
    for (const text of sources) for (const origin of origins) expect(text).not.toContain(origin);
    expect(nginxConf).not.toMatch(/https?:\/\//);
  });

  /** The directives of an nginx file with the names of the blocks around each: `["http", "server"]`. */
  function nginxDirectives(text: string): { name: string; args: string; inside: string[] }[] {
    const found: { name: string; args: string; inside: string[] }[] = [];
    const stack: string[] = [];
    let statement = "";
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        statement += char;
        quoted = char !== '"';
      } else if (char === '"') {
        statement += char;
        quoted = true;
      } else if (char === "#") {
        while (index + 1 < text.length && text[index + 1] !== "\n") index += 1;
      } else if (char === "{") {
        stack.push(statement.trim().split(/\s+/)[0]);
        statement = "";
      } else if (char === "}") {
        stack.pop();
        statement = "";
      } else if (char === ";") {
        const [name, ...args] = statement.trim().split(/\s+/);
        found.push({ name, args: args.join(" "), inside: [...stack] });
        statement = "";
      } else {
        statement += char;
      }
    }
    return found;
  }

  it("is read by the parser below: it finds the server and its locations", () => {
    const found = nginxDirectives(nginxConf);
    expect(found.some((d) => d.name === "listen" && d.inside.join(">") === "http>server")).toBe(true);
    expect(found.filter((d) => d.name === "try_files").map((d) => d.inside.join(">"))).toEqual(["http>server>location", "http>server>location"]);
  });

  it("includes the generated header at server level, once", () => {
    const includes = nginxDirectives(nginxConf).filter((d) => d.name === "include" && d.args.endsWith("csp.conf"));
    expect(includes).toHaveLength(1);
    expect(includes[0].args).toBe("/etc/nginx/csp.conf");
    expect(includes[0].inside).toEqual(["http", "server"]);
  });

  it("has no add_header anywhere, so no location block drops the server-level header", () => {
    expect(nginxDirectives(nginxConf).filter((d) => d.name === "add_header")).toEqual([]);
    expect(nginxConf.replace(/#.*$/gm, "")).not.toMatch(/add_header/);
  });

  it("has no include inside a location, and the include file sets the header with always", () => {
    expect(nginxDirectives(nginxConf).filter((d) => d.name === "include" && d.inside.includes("location"))).toEqual([]);
    const include = nginxInclude(buildCsp(realConfig));
    expect(nginxDirectives(include)).toEqual([
      { name: "add_header", args: expect.stringMatching(/^Content-Security-Policy ".+" always$/), inside: [] },
    ]);
  });
});
