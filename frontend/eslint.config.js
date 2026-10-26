import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

// Network calls go through the generated client in src/api/client.ts. These rules ban the
// primitives (not a path pattern), so a URL built in a variable cannot slip past them.
// They apply to every linted file, including src/api/ and tests. Plain links such as
// <a href="/api/..."> are not network calls from code and are not affected.
const USE_CLIENT = "Use the generated API client from src/api/client.";

const networkGlobals = ["fetch", "XMLHttpRequest", "EventSource", "WebSocket"];
const globalObjects = "/^(window|globalThis|self|global)$/";

const restrictedGlobals = networkGlobals.map((name) => ({
  name,
  message: `${USE_CLIENT} Do not use ${name} directly.`,
}));

const restrictedSyntax = [
  // window.fetch, globalThis.fetch, self.XMLHttpRequest, globalThis["fetch"], ...
  ...[...networkGlobals, "Request"].flatMap((name) => [
    {
      selector: `MemberExpression[object.name=${globalObjects}][property.name="${name}"][computed=false]`,
      message: `${USE_CLIENT} Do not use ${name} directly.`,
    },
    {
      selector: `MemberExpression[object.name=${globalObjects}][property.value="${name}"][computed=true]`,
      message: `${USE_CLIENT} Do not use ${name} directly.`,
    },
  ]),
  {
    selector: "NewExpression[callee.name='Request']",
    message: `${USE_CLIENT} Do not build a Request by hand.`,
  },
];

// Lesson text is author text and must only ever be rendered as text. In the renderer and the
// lesson page, nothing may turn a string into markup. Built-in rules only (no plugin): this is
// react/no-danger plus the DOM calls that do the same thing.
const NO_HTML = "Author text is rendered as text only. Do not build HTML from it.";
const HTML_NAMES = "/^(dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML)$/";
const noHtmlSyntax = [
  { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: `${NO_HTML} Do not use dangerouslySetInnerHTML.` },
  // { dangerouslySetInnerHTML: ... }, { innerHTML } = el, { "innerHTML": ... }
  { selector: `Property[key.name=${HTML_NAMES}]`, message: `${NO_HTML} Do not use this property.` },
  { selector: `Property[key.value=${HTML_NAMES}]`, message: `${NO_HTML} Do not use this property.` },
  // el.innerHTML, el["innerHTML"], el.insertAdjacentHTML(...)
  { selector: `MemberExpression[property.name=${HTML_NAMES}][computed=false]`, message: `${NO_HTML} Do not use this property.` },
  { selector: `MemberExpression[property.value=${HTML_NAMES}][computed=true]`, message: `${NO_HTML} Do not use this property.` },
  { selector: "MemberExpression[object.name='document'][property.name=/^(write|writeln)$/]", message: `${NO_HTML} Do not use document.write.` },
];

const httpLibraries = ["axios", "ky", "got", "superagent", "node-fetch", "cross-fetch", "ofetch"];
const restrictedLibraryPaths = httpLibraries.map((name) => ({
  name,
  message: `${USE_CLIENT} Do not add another HTTP library.`,
}));
const restrictedLibraryPatterns = httpLibraries.map((name) => ({
  group: [`${name}/*`],
  message: `${USE_CLIENT} Do not add another HTTP library.`,
}));
const secondClient = {
  name: "openapi-fetch",
  message: `${USE_CLIENT} A second client with its own base URL would bypass the shared one.`,
};

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx,js}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "no-restricted-globals": ["error", ...restrictedGlobals],
      "no-restricted-syntax": ["error", ...restrictedSyntax],
    },
  },
  // Only src/api/ may import openapi-fetch. Two blocks with disjoint files, so the HTTP library
  // bans apply everywhere and nothing is switched off.
  {
    files: ["**/*.{ts,tsx,js}"],
    ignores: ["src/api/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [...restrictedLibraryPaths, secondClient], patterns: [...restrictedLibraryPatterns, { group: ["openapi-fetch/*"], message: secondClient.message }] },
      ],
    },
  },
  {
    files: ["src/api/**/*.{ts,tsx,js}"],
    rules: {
      "no-restricted-imports": ["error", { paths: restrictedLibraryPaths, patterns: restrictedLibraryPatterns }],
    },
  },
  // The renderer and the lesson page. A later block replaces the rule's whole list for these
  // files, so the network bans are repeated here.
  {
    files: ["src/content-components/**/*.{ts,tsx}", "src/pages/LessonPage.tsx"],
    rules: {
      "no-restricted-syntax": ["error", ...restrictedSyntax, ...noHtmlSyntax],
    },
  },
);
