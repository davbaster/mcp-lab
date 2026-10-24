// Entry point of `npm run validate -- <course folder>`.

import { main } from "./cli.ts";

process.exitCode = main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
