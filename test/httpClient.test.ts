/**
 * NtlmHttpClient against a throwaway http.Server on 127.0.0.1:
 *  - the full three-leg NTLM handshake (negotiate -> challenge -> authenticate)
 *    completes on a single pinned socket and returns the authenticated body;
 *  - server throttling (429 / 503, with and without Retry-After) and transient
 *    socket errors are retried with a jittered backoff (sleep is stubbed).
 *
 * No live farm. The handshake message *contents* are unit-tested separately in
 * test/ntlm.test.ts against the MS-NLMP vectors; this proves the client wiring.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { NtlmHttpClient } from '../src/auth/httpClient';
import { NetworkError } from '../src/util/errors';

const CREDS = { username: 'svc_audit', password: 'p@ss', domain: 'CONTOSO' };
const NO_WAIT = (): Promise<void> => Promise.resolve();

interface Fixture {
  url: string;
  connections: () => number;
  close: () => Promise<void>;
}

function serve(handler: http.RequestListener): Promise<Fixture> {
  const server = http.createServer(handler);
  let connections = 0;
  server.on('connection', () => {
    connections++;
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/sites/hr/_api/web`,
        connections: () => connections,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/** Minimal well-formed NTLM Type 2 (CHALLENGE): signature, type, flags, 8-byte challenge. */
function fakeType2Base64(): string {
  const b = Buffer.alloc(32);
  Buffer.from('NTLMSSP\0', 'latin1').copy(b, 0);
  b.writeUInt32LE(2, 8);
  b.writeUInt32LE(0x00080001, 20); // unicode + extended session security
  Buffer.from('SrvChal!', 'latin1').copy(b, 24);
  return b.toString('base64');
}

/** Message type (1/2/3) of a base64 "NTLM xxxx" Authorization header value. */
function ntlmMessageType(authHeader: string | undefined): number | null {
  const m = /^NTLM\s+([A-Za-z0-9+/=]+)$/.exec(authHeader ?? '');
  if (!m) return null;
  const buf = Buffer.from(m[1]!, 'base64');
  return buf.length >= 12 ? buf.readUInt32LE(8) : null;
}

test('completes the three-leg NTLM handshake on one socket and returns the body', async () => {
  const seen: Array<number | null> = [];
  const fx = await serve((req, res) => {
    const kind = ntlmMessageType(req.headers.authorization);
    seen.push(kind);
    if (req.headers.authorization === undefined) {
      res.setHeader('WWW-Authenticate', 'NTLM');
      res.statusCode = 401;
      res.end('negotiate');
      return;
    }
    if (kind === 1) {
      res.setHeader('WWW-Authenticate', `NTLM ${fakeType2Base64()}`);
      res.statusCode = 401;
      res.end('challenge');
      return;
    }
    if (kind === 3) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end('{"d":{"Title":"HR"}}');
      return;
    }
    res.statusCode = 500;
    res.end('unexpected');
  });

  const client = new NtlmHttpClient({ credentials: CREDS, sleep: NO_WAIT });
  try {
    const res = await client.request({ method: 'GET', url: fx.url });
    assert.equal(res.status, 200);
    assert.equal(res.body.toString('utf8'), '{"d":{"Title":"HR"}}');
    assert.deepEqual(seen, [null, 1, 3], 'server saw: no-auth, Type 1, Type 3');
    assert.equal(fx.connections(), 1, 'all three legs travelled over the same socket');
  } finally {
    client.destroy();
    await fx.close();
  }
});

test('retries a 503 then succeeds', async () => {
  let hits = 0;
  const fx = await serve((_req, res) => {
    hits++;
    if (hits === 1) {
      res.statusCode = 503;
      res.end('busy');
      return;
    }
    res.statusCode = 200;
    res.end('ok');
  });

  const client = new NtlmHttpClient({ credentials: CREDS, retries: 3, sleep: NO_WAIT });
  try {
    const res = await client.request({ method: 'GET', url: fx.url });
    assert.equal(res.status, 200);
    assert.equal(hits, 2);
  } finally {
    client.destroy();
    await fx.close();
  }
});

test('honours Retry-After on a 429', async () => {
  const waits: number[] = [];
  let hits = 0;
  const fx = await serve((_req, res) => {
    hits++;
    if (hits <= 2) {
      res.statusCode = 429;
      res.setHeader('Retry-After', '1');
      res.end('slow down');
      return;
    }
    res.statusCode = 200;
    res.end('ok');
  });

  const client = new NtlmHttpClient({
    credentials: CREDS,
    retries: 5,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  try {
    const res = await client.request({ method: 'GET', url: fx.url });
    assert.equal(res.status, 200);
    assert.equal(hits, 3);
    assert.deepEqual(waits, [1000, 1000], 'each wait came from Retry-After: 1 (second)');
  } finally {
    client.destroy();
    await fx.close();
  }
});

test('gives up after `retries` throttled responses and returns the last one', async () => {
  let hits = 0;
  const fx = await serve((_req, res) => {
    hits++;
    res.statusCode = 429;
    res.setHeader('Retry-After', '0');
    res.end('always busy');
  });

  const client = new NtlmHttpClient({ credentials: CREDS, retries: 2, sleep: NO_WAIT });
  try {
    const res = await client.request({ method: 'GET', url: fx.url });
    assert.equal(res.status, 429);
    assert.equal(hits, 3, '1 initial attempt + 2 retries');
  } finally {
    client.destroy();
    await fx.close();
  }
});

test('retries a transient ECONNRESET then succeeds', async () => {
  let hits = 0;
  const fx = await serve((req, res) => {
    hits++;
    if (hits === 1) {
      req.socket.destroy();
      return;
    }
    res.statusCode = 200;
    res.end('recovered');
  });

  const client = new NtlmHttpClient({ credentials: CREDS, retries: 2, sleep: NO_WAIT });
  try {
    const res = await client.request({ method: 'GET', url: fx.url });
    assert.equal(res.status, 200);
    assert.equal(res.body.toString('utf8'), 'recovered');
    assert.equal(hits, 2);
  } finally {
    client.destroy();
    await fx.close();
  }
});

test('concurrency: 1 (default) serialises requests', async () => {
  let active = 0;
  let peak = 0;
  const fx = await serve((_req, res) => {
    active++;
    peak = Math.max(peak, active);
    setTimeout(() => {
      active--;
      res.end('ok');
    }, 15);
  });

  const client = new NtlmHttpClient({ credentials: CREDS });
  try {
    await Promise.all(
      Array.from({ length: 4 }, () => client.request({ method: 'GET', url: fx.url })),
    );
    assert.equal(peak, 1, 'one request in flight at a time');
  } finally {
    client.destroy();
    await fx.close();
  }
});

test('concurrency: N runs up to N requests in parallel', async () => {
  let active = 0;
  let peak = 0;
  const fx = await serve((_req, res) => {
    active++;
    peak = Math.max(peak, active);
    setTimeout(() => {
      active--;
      res.end('ok');
    }, 15);
  });

  const client = new NtlmHttpClient({ credentials: CREDS, concurrency: 3 });
  try {
    await Promise.all(
      Array.from({ length: 6 }, () => client.request({ method: 'GET', url: fx.url })),
    );
    assert.equal(peak, 3, 'at most `concurrency` requests in flight');
  } finally {
    client.destroy();
    await fx.close();
  }
});

test('concurrency: each lane runs its own handshake, legs stay on its socket', async () => {
  const perConn = new Map<import('node:net').Socket, string[]>();
  const fx = await serve((req, res) => {
    const seq = perConn.get(req.socket) ?? [];
    const kind = ntlmMessageType(req.headers.authorization);
    seq.push(req.headers.authorization === undefined ? 'none' : `type${kind}`);
    perConn.set(req.socket, seq);

    if (req.headers.authorization === undefined) {
      res.setHeader('WWW-Authenticate', 'NTLM');
      res.statusCode = 401;
      res.end('negotiate');
    } else if (kind === 1) {
      res.setHeader('WWW-Authenticate', `NTLM ${fakeType2Base64()}`);
      res.statusCode = 401;
      res.end('challenge');
    } else {
      res.statusCode = 200;
      res.end('{"ok":true}');
    }
  });

  const client = new NtlmHttpClient({ credentials: CREDS, concurrency: 2 });
  try {
    const [a, b] = await Promise.all([
      client.request({ method: 'GET', url: fx.url }),
      client.request({ method: 'GET', url: fx.url }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(fx.connections(), 2, 'two lanes -> two sockets');
    for (const seq of perConn.values()) {
      // Each socket saw one coherent handshake, never another request's legs.
      assert.deepEqual(seq, ['none', 'type1', 'type3']);
    }
  } finally {
    client.destroy();
    await fx.close();
  }
});

test('does not retry a non-transient socket error (ECONNREFUSED)', async () => {
  const fx = await serve((_req, res) => res.end());
  const deadUrl = fx.url;
  await fx.close();

  let slept = 0;
  const client = new NtlmHttpClient({
    credentials: CREDS,
    retries: 3,
    sleep: () => {
      slept++;
      return Promise.resolve();
    },
  });
  try {
    await assert.rejects(client.request({ method: 'GET', url: deadUrl }), (err: unknown) => {
      assert.ok(err instanceof NetworkError);
      assert.match(err.message, /ECONNREFUSED/);
      return true;
    });
    assert.equal(slept, 0, 'ECONNREFUSED is not retryable');
  } finally {
    client.destroy();
  }
});
