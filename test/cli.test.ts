import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/cli';
import { VERSION } from '../src/version';
import { UsageError } from '../src/util/errors';

function capture(): { restore: () => void; out: () => string } {
  const chunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const sink = (s: string | Uint8Array): boolean => {
    chunks.push(typeof s === 'string' ? s : Buffer.from(s).toString());
    return true;
  };
  (process.stdout.write as unknown) = sink;
  (process.stderr.write as unknown) = sink;
  return {
    restore: () => {
      (process.stdout.write as unknown) = origOut;
      (process.stderr.write as unknown) = origErr;
    },
    out: () => chunks.join(''),
  };
}

function withoutCredsEnv<T>(fn: () => T): T {
  const saved = {
    u: process.env['SPPERM_USERNAME'],
    p: process.env['SPPERM_PASSWORD'],
    d: process.env['SPPERM_DOMAIN'],
  };
  delete process.env['SPPERM_USERNAME'];
  delete process.env['SPPERM_PASSWORD'];
  delete process.env['SPPERM_DOMAIN'];
  try {
    return fn();
  } finally {
    if (saved.u !== undefined) process.env['SPPERM_USERNAME'] = saved.u;
    if (saved.p !== undefined) process.env['SPPERM_PASSWORD'] = saved.p;
    if (saved.d !== undefined) process.env['SPPERM_DOMAIN'] = saved.d;
  }
}

test('--version prints the version and exits 0', async () => {
  const cap = capture();
  try {
    const code = await run(['--version']);
    assert.equal(code, 0);
    assert.equal(cap.out().trim(), VERSION);
  } finally {
    cap.restore();
  }
});

test('--help exits 0; no args exits 2', async () => {
  const cap = capture();
  try {
    assert.equal(await run(['--help']), 0);
    assert.equal(await run([]), 2);
    assert.match(cap.out(), /USAGE/);
  } finally {
    cap.restore();
  }
});

test('unknown command is a usage error', async () => {
  const cap = capture();
  try {
    await assert.rejects(run(['frobnicate']), (e: unknown) => e instanceof UsageError);
  } finally {
    cap.restore();
  }
});

test('missing credentials is a usage error before any network call', async () => {
  const cap = capture();
  try {
    await withoutCredsEnv(async () => {
      await assert.rejects(
        run(['explain-access', '--site', 'https://sp/sites/hr', '--user', 'contoso\\jane']),
        (e: unknown) => e instanceof UsageError && /credentials/i.test((e as Error).message),
      );
    });
  } finally {
    cap.restore();
  }
});

test('invalid --format is rejected', async () => {
  const cap = capture();
  try {
    await withoutCredsEnv(async () => {
      await assert.rejects(
        run(['scan-site', '--site', 'https://sp', '--format', 'yaml']),
        (e: unknown) => e instanceof UsageError,
      );
    });
  } finally {
    cap.restore();
  }
});
