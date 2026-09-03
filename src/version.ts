/**
 * Single source of truth for the CLI version: the `version` field of the
 * package's own `package.json`. Resolved relative to this compiled file
 * (`dist/src/version.js` -> `../../package.json`), which holds both in the repo
 * and in an installed package tree.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readVersion(): string {
  try {
    const raw = readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readVersion();
