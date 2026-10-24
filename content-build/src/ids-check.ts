// Entry point of `npm run ids:check -- <courses folder> [--base <git ref>]`.

import { checkMain } from "./ids-cli.ts";

process.exitCode = checkMain(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
