// Entry point of `npm run install:browser`.

import { installBrowser } from "./browser-install.ts";

process.exitCode = await installBrowser();
