// Entry point of `npm run build -- <courses folder> <build folder>`.

import { main } from "./build-cli.ts";

process.exitCode = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
