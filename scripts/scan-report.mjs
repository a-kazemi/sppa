#!/usr/bin/env node
// Re-render a saved `sppa scan-site --format json` envelope as the standalone
// HTML report, without re-scanning the farm.
//
//   node scripts/scan-report.mjs dms-audit.json > report.html
//   sppa scan-site --site <url> --format json | node scripts/scan-report.mjs > report.html
//
// `sppa scan-site` already writes this report by default (see --report /
// --no-report); use this script only when you have JSON but no live connection.
// It shares one implementation with the CLI: build first (`npm run build`).

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let renderScanHtml;
try {
  ({ renderScanHtml } = require('../dist/src/report/html.js'));
} catch {
  console.error('scan-report: build first — `npm run build`');
  process.exit(1);
}

const arg = process.argv[2];
const raw = arg && arg !== '-' ? readFileSync(arg, 'utf8') : readFileSync(0, 'utf8');

let envelope;
try {
  envelope = JSON.parse(raw);
} catch (e) {
  console.error(`scan-report: input is not valid JSON (${e.message})`);
  process.exit(1);
}
if (envelope?.command !== 'scan-site') {
  console.error('scan-report: expected a `sppa scan-site --format json` envelope');
  process.exit(1);
}

process.stdout.write(renderScanHtml(envelope));
