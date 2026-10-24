// Entry point of `npm run compile -- <lesson.mdx>`.

import { main } from "./compile-cli.ts";

process.exitCode = main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
