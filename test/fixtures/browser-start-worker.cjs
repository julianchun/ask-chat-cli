"use strict";

const { ensureManagedChrome } = require("../../dist/browser.js");

void ensureManagedChrome({
  env: process.env,
  desiredMode: "headless",
  requireManaged: true,
  timeoutMs: 20_000
}).then(
  (session) => {
    process.stdout.write(`${JSON.stringify(session)}\n`);
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
);
