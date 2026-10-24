// Fails when src/api/schema.d.ts differs from what the generator writes for ../openapi.yaml.
// It runs the exact command of the `generate:api` script in package.json, but writes to a
// temp folder, so it never changes a tracked file and does not need git.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const committedFile = join(frontendDir, "src", "api", "schema.d.ts");
const require = createRequire(join(frontendDir, "package.json"));

class CheckFailed extends Error {}
const fail = (message) => {
  throw new CheckFailed(message);
};

function check() {
  const generateScript = JSON.parse(readFileSync(join(frontendDir, "package.json"), "utf8")).scripts["generate:api"];
  const [command, ...args] = generateScript.split(/\s+/);
  if (command !== "openapi-typescript") fail(`expected the generate:api script to run openapi-typescript, found: ${generateScript}`);
  const outputIndex = args.indexOf("--output");
  if (outputIndex === -1) fail("the generate:api script has no --output option");

  const generatorPackage = require("openapi-typescript/package.json");
  const cli = join(dirname(require.resolve("openapi-typescript/package.json")), generatorPackage.bin["openapi-typescript"]);

  const tempDir = mkdtempSync(join(tmpdir(), "check-api-"));
  try {
    const generatedFile = join(tempDir, "schema.d.ts");
    args[outputIndex + 1] = generatedFile;
    try {
      execFileSync(process.execPath, [cli, ...args], { cwd: frontendDir, stdio: ["ignore", "ignore", "inherit"] });
    } catch {
      fail("the generator could not read ../openapi.yaml (see the error above).");
    }
    const generated = readFileSync(generatedFile);
    let committed;
    try {
      committed = readFileSync(committedFile);
    } catch {
      fail("src/api/schema.d.ts is missing. Run `npm run generate:api` in frontend/ and commit the file.");
    }
    if (!generated.equals(committed)) {
      fail("src/api/schema.d.ts is out of date with openapi.yaml (or was edited by hand). Run `npm run generate:api` in frontend/ and commit the file.");
    }
    console.log("src/api/schema.d.ts is up to date with openapi.yaml.");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

try {
  check();
} catch (error) {
  if (!(error instanceof CheckFailed)) throw error;
  console.error(`check:api failed: ${error.message}`);
  process.exitCode = 1;
}
