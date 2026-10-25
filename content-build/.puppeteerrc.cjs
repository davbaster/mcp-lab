// npm ci must not download a browser: `npm run install:browser` does, and only chrome-headless-shell.
// The same setting is in the "puppeteer" key of package.json, because the backend image copies only package.json and the lock
// file before it runs `npm ci`, so this file is not there yet.
/** @type {import("puppeteer").Configuration} */
module.exports = {
  skipDownload: true,
};
