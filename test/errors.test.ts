/**
 * Guardrail test for the error surface documented in docs/TROUBLESHOOTING.md.
 *
 * Two jobs:
 *  1. The exit-code contract (usage 2 / auth 3 / API 4 / network 5) stays fixed.
 *  2. The exact `error:` strings a user sees are the ones the doc explains, and
 *     the code paths that produce them still produce them. If someone reworders
 *     a message, this test fails and points them at docs/TROUBLESHOOTING.md so
 *     the pre-written issue-tracker answers do not silently rot.
 *
 * No live farm and no external network: the `_api` layer is driven through the
 * existing SharePointClient constructor seam, and the NTLM handshake mapping is
 * driven against a throwaway http.Server on 127.0.0.1.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { NtlmHttpClient, HttpResponse } from '../src/auth/httpClient';
import { SharePointClient } from '../src/sp/client';
import { AuthError, ApiError, NetworkError, UsageError, CliError } from '../src/util/errors';

const SITE = 'https://sp.contoso.local/sites/hr';

/** Canonical fragments of every user-facing error string, keyed by doc anchor. */
const DOCUMENTED_STRINGS = [
  'NTLM authentication was rejected (401 after handshake).',
  'Server offered "',
  '" but not NTLM.',
  'Server did not return an NTLM Type 2 challenge.',
  'Not authorised for ',
  'Not found: ',
  'SharePoint returned a non-JSON response for ',
  'SharePoint returned HTTP ',
  'Network error (ENOTFOUND)',
  'Network error (ECONNREFUSED)',
  'Network error (ETIMEDOUT)',
  'Request timed out after ',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
];

// --------------------------------------------------------------------------
// 1. Exit-code contract
// --------------------------------------------------------------------------

test('error classes keep the documented exit codes', () => {
  assert.equal(new UsageError('x').exitCode, 2);
  assert.equal(new AuthError('x').exitCode, 3);
  assert.equal(new ApiError('x').exitCode, 4);
  assert.equal(new NetworkError('x').exitCode, 5);
  // Bare CliError defaults to 1 (the "unexpected" bucket).
  assert.equal(new CliError('x').exitCode, 1);
  for (const E of [UsageError, AuthError, ApiError, NetworkError]) {
    assert.ok(new E('x') instanceof CliError, `${E.name} must extend CliError`);
  }
});

test('the optional remediation hint round-trips', () => {
  assert.equal(new ApiError('m', 'do this').hint, 'do this');
  assert.equal(new ApiError('m').hint, undefined);
});

// --------------------------------------------------------------------------
// 2a. `_api` authorisation / API errors via the SharePointClient seam
// --------------------------------------------------------------------------

/** Minimal NtlmHttpClient stand-in that returns one canned response. */
class CannedHttp {
  constructor(private readonly res: Partial<HttpResponse> & { status: number; body: Buffer }) {}
  request(): Promise<HttpResponse> {
    return Promise.resolve({ headers: {}, ...this.res });
  }
  destroy(): void {}
}

function clientReturning(status: number, body: string): SharePointClient {
  return new SharePointClient(
    new CannedHttp({ status, body: Buffer.from(body, 'utf8') }) as unknown as NtlmHttpClient,
    SITE,
  );
}

test('_api 401 -> AuthError "Not authorised for <url>" (exit 3)', async () => {
  await assert.rejects(clientReturning(401, '').getWeb(), (err: unknown) => {
    assert.ok(err instanceof AuthError);
    assert.equal(err.exitCode, 3);
    assert.match(err.message, /^Not authorised for https:\/\/sp\.contoso\.local\/sites\/hr\/_api\/web/);
    return true;
  });
});

test('_api 404 -> ApiError "Not found: <url>" with the documented hint (exit 4)', async () => {
  await assert.rejects(clientReturning(404, 'not found').getWeb(), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.exitCode, 4);
    assert.match(err.message, /^Not found: https:\/\/sp\.contoso\.local\/sites\/hr\/_api\/web/);
    assert.equal(err.hint, 'Check the --site URL and object name.');
    return true;
  });
});

test('_api 500 -> ApiError "SharePoint returned HTTP 500 for <url>" (exit 4)', async () => {
  await assert.rejects(
    clientReturning(500, 'Microsoft.SharePoint.Client.ServerException: boom').getWeb(),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.exitCode, 4);
      assert.match(err.message, /^SharePoint returned HTTP 500 for https:\/\/sp\.contoso\.local\S*_api\/web/);
      assert.match(String(err.hint), /Microsoft\.SharePoint\.Client\.ServerException/);
      return true;
    },
  );
});

test('_api 200 with an HTML sign-in page -> ApiError "non-JSON response" (exit 4)', async () => {
  await assert.rejects(
    clientReturning(200, '<html><body>Sign In</body></html>').getWeb(),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.exitCode, 4);
      assert.match(err.message, /^SharePoint returned a non-JSON response for /);
      assert.match(String(err.hint), /sign-in page/);
      return true;
    },
  );
});

// --------------------------------------------------------------------------
// 2b. NTLM handshake mapping via a throwaway localhost server
// --------------------------------------------------------------------------

interface Fixture {
  url: string;
  close: () => Promise<void>;
}

/** Start an http.Server on 127.0.0.1 with the given handler; return its URL. */
function serve(handler: http.RequestListener): Promise<Fixture> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as import('node:net').AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}/sites/hr/_api/web`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const CREDS = { username: 'u', password: 'p', domain: 'CONTOSO' };

test('401 offering only Negotiate -> AuthError "Server offered ... but not NTLM."', async () => {
  const fx = await serve((_req, res) => {
    res.setHeader('WWW-Authenticate', 'Negotiate');
    res.statusCode = 401;
    res.end('no');
  });
  const client = new NtlmHttpClient({ credentials: CREDS });
  try {
    await assert.rejects(client.request({ method: 'GET', url: fx.url }), (err: unknown) => {
      assert.ok(err instanceof AuthError);
      assert.equal(err.exitCode, 3);
      assert.equal(err.message, 'Server offered "Negotiate" but not NTLM.');
      return true;
    });
  } finally {
    client.destroy();
    await fx.close();
  }
});

test('NTLM offered but no Type 2 challenge -> AuthError "did not return an NTLM Type 2 challenge."', async () => {
  const fx = await serve((req, res) => {
    if (!req.headers.authorization) {
      // Leg 0: advertise NTLM so the client starts the handshake.
      res.setHeader('WWW-Authenticate', 'NTLM');
      res.statusCode = 401;
      res.end('challenge me');
      return;
    }
    // Leg 1: client sent the Type 1 message; reply with no NTLM challenge.
    res.setHeader('WWW-Authenticate', 'Basic realm="x"');
    res.statusCode = 401;
    res.end('nope');
  });
  const client = new NtlmHttpClient({ credentials: CREDS });
  try {
    await assert.rejects(client.request({ method: 'GET', url: fx.url }), (err: unknown) => {
      assert.ok(err instanceof AuthError);
      assert.equal(err.exitCode, 3);
      assert.equal(err.message, 'Server did not return an NTLM Type 2 challenge.');
      return true;
    });
  } finally {
    client.destroy();
    await fx.close();
  }
});

test('nothing listening -> NetworkError naming ECONNREFUSED (exit 5)', async () => {
  // Bind then immediately release a port so the connect is guaranteed refused.
  const fx = await serve((_req, res) => res.end());
  const deadUrl = fx.url;
  await fx.close();

  const client = new NtlmHttpClient({ credentials: CREDS });
  try {
    await assert.rejects(client.request({ method: 'GET', url: deadUrl }), (err: unknown) => {
      assert.ok(err instanceof NetworkError);
      assert.equal(err.exitCode, 5);
      assert.match(err.message, /Network error \(ECONNREFUSED\) reaching /);
      return true;
    });
  } finally {
    client.destroy();
  }
});

// --------------------------------------------------------------------------
// 3. Doc / code agreement
// --------------------------------------------------------------------------

test('every documented error string is present in docs/TROUBLESHOOTING.md', () => {
  const doc = fs.readFileSync(path.resolve(__dirname, '../../docs/TROUBLESHOOTING.md'), 'utf8');
  for (const fragment of DOCUMENTED_STRINGS) {
    assert.ok(
      doc.includes(fragment),
      `docs/TROUBLESHOOTING.md is missing the error fragment: ${JSON.stringify(fragment)}`,
    );
  }
});

test('the TLS certificate error hint still points at --insecure', async () => {
  // Exercised indirectly: mapNetworkError is private, but the doc promises the
  // hint, and the httpClient source is the single source of truth for it.
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/auth/httpClient.ts'), 'utf8');
  assert.match(src, /DEPTH_ZERO_SELF_SIGNED_CERT[\s\S]*--insecure/);
  assert.match(src, /ENOTFOUND[\s\S]*DNS lookup failed/);
});
