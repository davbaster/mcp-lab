// Entry point of `npm run ids:update -- <courses folder>`.

import { updateMain } from "./ids-cli.ts";

process.exitCode = updateMain(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
