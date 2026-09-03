/**
 * HTTP(S) client that performs the NTLM handshake on a pinned keep-alive socket.
 *
 * NTLM authenticates the TCP connection, not the individual request, so all
 * three legs of the handshake (negotiate -> challenge -> authenticate) plus the
 * final authenticated request must travel over the same socket. We enforce that
 * with "lanes": each lane owns a per-origin Agent capped at a single socket and
 * serves one `request()` at a time, so a request's legs never interleave with
 * another's. `concurrency` lanes run in parallel — each does its own handshake
 * once, then reuses its authenticated socket. Response bodies are always drained
 * so the socket returns cleanly to the keep-alive pool.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import { buildType1Message, buildType3Message, parseType2Message } from './ntlm';
import { AuthError, NetworkError } from '../util/errors';

export interface Credentials {
  username: string;
  password: string;
  domain: string;
  workstation?: string;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface NtlmHttpClientOptions {
  credentials: Credentials;
  /** Disable TLS certificate verification (internal/self-signed farms). */
  insecure?: boolean;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * How many times to retry a throttled (429/503) or transient-socket
   * (ECONNRESET/ETIMEDOUT/EPIPE) response before giving up. Default 3; 0 disables.
   */
  retries?: number;
  /** Base for the exponential backoff between retries, in ms. Default 500. */
  retryBaseMs?: number;
  /** Upper bound on any single backoff / Retry-After wait, in ms. Default 60000. */
  maxRetryDelayMs?: number;
  /** Sleep implementation — overridable so tests do not wait in real time. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * How many authenticated connections to run in parallel. Each is a separate
   * NTLM handshake. Default 1 (fully serial, the safe choice for a sensitive
   * farm); raise it to speed up `scan-site` on a large site collection.
   */
  concurrency?: number;
}

const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED', 'EAI_AGAIN']);

interface RawRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Buffer;
}

/** One serialised authenticated connection: its own single-socket agents. */
interface Lane {
  agents: Map<string, http.Agent | https.Agent>;
  busy: boolean;
  waiters: Array<() => void>;
}

export class NtlmHttpClient {
  private readonly creds: Required<Credentials>;
  private readonly insecure: boolean;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryBaseMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly lanes: Lane[];

  constructor(opts: NtlmHttpClientOptions) {
    this.creds = {
      username: opts.credentials.username,
      password: opts.credentials.password,
      domain: opts.credentials.domain,
      workstation: opts.credentials.workstation || 'WORKSTATION',
    };
    this.insecure = Boolean(opts.insecure);
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.retries = Math.max(0, opts.retries ?? 3);
    this.retryBaseMs = Math.max(0, opts.retryBaseMs ?? 500);
    this.maxRetryDelayMs = Math.max(0, opts.maxRetryDelayMs ?? 60000);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const poolSize = Math.max(1, Math.floor(opts.concurrency ?? 1));
    this.lanes = Array.from({ length: poolSize }, () => ({
      agents: new Map<string, http.Agent | https.Agent>(),
      busy: false,
      waiters: [] as Array<() => void>,
    }));
  }

  /** Take a free lane, or wait for one to be released. */
  private acquireLane(): Promise<Lane> {
    const free = this.lanes.find((l) => !l.busy);
    if (free) {
      free.busy = true;
      return Promise.resolve(free);
    }
    const lane = this.lanes.reduce((a, b) => (b.waiters.length < a.waiters.length ? b : a));
    return new Promise<Lane>((resolve) => lane.waiters.push(() => resolve(lane)));
  }

  private releaseLane(lane: Lane): void {
    const next = lane.waiters.shift();
    if (next) next();
    else lane.busy = false;
  }

  private agentFor(lane: Lane, u: URL): http.Agent | https.Agent {
    const key = `${u.protocol}//${u.host}`;
    let agent = lane.agents.get(key);
    if (!agent) {
      const common = { keepAlive: true, maxSockets: 1, maxFreeSockets: 1 };
      agent =
        u.protocol === 'https:'
          ? new https.Agent({ ...common, rejectUnauthorized: !this.insecure })
          : new http.Agent(common);
      lane.agents.set(key, agent);
    }
    return agent;
  }

  private rawRequest(lane: Lane, opts: RawRequestOptions): Promise<HttpResponse> {
    const u = new URL(opts.url);
    const transport = u.protocol === 'https:' ? https : http;
    const agent = this.agentFor(lane, u);

    return new Promise<HttpResponse>((resolve, reject) => {
      const req = transport.request(
        {
          method: opts.method,
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          agent,
          headers: {
            Connection: 'keep-alive',
            'User-Agent': 'sppa',
            ...(opts.headers ?? {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
          res.on('error', reject);
        },
      );

      req.setTimeout(this.timeoutMs, () => {
        const e = new NetworkError(`Request timed out after ${this.timeoutMs}ms: ${opts.url}`);
        e.code = 'ETIMEDOUT';
        req.destroy(e);
      });
      req.on('error', (err: NodeJS.ErrnoException) => reject(mapNetworkError(err, opts.url)));
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  /**
   * Issue an NTLM-authenticated request, retrying on server throttling (429 /
   * 503, honouring `Retry-After`) and transient socket errors with a jittered
   * exponential backoff. The whole handshake is re-run on each retry — a fresh
   * socket, a fresh negotiate.
   */
  async request(opts: RawRequestOptions): Promise<HttpResponse> {
    const lane = await this.acquireLane();
    try {
      return await this.requestOnLane(lane, opts);
    } finally {
      this.releaseLane(lane);
    }
  }

  private async requestOnLane(lane: Lane, opts: RawRequestOptions): Promise<HttpResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.attempt(lane, opts);
        if ((res.status === 429 || res.status === 503) && attempt < this.retries) {
          await this.sleep(this.retryDelay(res.headers['retry-after'], attempt));
          continue;
        }
        return res;
      } catch (err) {
        if (
          attempt < this.retries &&
          err instanceof NetworkError &&
          err.code !== undefined &&
          RETRYABLE_CODES.has(err.code)
        ) {
          await this.sleep(this.retryDelay(undefined, attempt));
          continue;
        }
        throw err;
      }
    }
  }

  /** Milliseconds to wait before retry `attempt` (0-based). */
  private retryDelay(retryAfter: string | string[] | undefined, attempt: number): number {
    const fromHeader = parseRetryAfter(retryAfter);
    if (fromHeader !== undefined) return Math.min(fromHeader, this.maxRetryDelayMs);
    // Full-jitter exponential backoff: random in [0, base * 2^attempt].
    const ceiling = Math.min(this.retryBaseMs * 2 ** attempt, this.maxRetryDelayMs);
    return Math.floor(Math.random() * ceiling);
  }

  /** One full attempt: raw request, plus the NTLM handshake if challenged. */
  private async attempt(lane: Lane, opts: RawRequestOptions): Promise<HttpResponse> {
    const first = await this.rawRequest(lane, opts);
    if (first.status !== 401) return first;

    const offered = String(first.headers['www-authenticate'] ?? '');
    if (!/\bNTLM\b/i.test(offered)) {
      if (/\bNegotiate\b/i.test(offered) || /\bBasic\b/i.test(offered)) {
        throw new AuthError(
          `Server offered "${offered.trim()}" but not NTLM.`,
          'This build supports NTLM with explicit credentials only. If the web ' +
            'application uses AD FS / Kerberos-only / Forms-Based Auth, please open ' +
            'an issue describing your setup.',
        );
      }
      return first;
    }

    const type1 = buildType1Message().toString('base64');
    const challenge = await this.rawRequest(lane, {
      ...opts,
      headers: { ...(opts.headers ?? {}), Authorization: `NTLM ${type1}` },
    });

    const challengeHeader = String(challenge.headers['www-authenticate'] ?? '');
    const m = /NTLM\s+([A-Za-z0-9+/=]+)/.exec(challengeHeader);
    if (!m) {
      throw new AuthError(
        'Server did not return an NTLM Type 2 challenge.',
        'Confirm NTLM is enabled for this web application and that the account is not locked out.',
      );
    }

    const type2 = parseType2Message(Buffer.from(m[1]!, 'base64'));
    const type3 = buildType3Message(type2, {
      user: this.creds.username,
      password: this.creds.password,
      domain: this.creds.domain,
      workstation: this.creds.workstation,
    }).message.toString('base64');

    const authed = await this.rawRequest(lane, {
      ...opts,
      headers: { ...(opts.headers ?? {}), Authorization: `NTLM ${type3}` },
    });

    if (authed.status === 401) {
      throw new AuthError(
        'NTLM authentication was rejected (401 after handshake).',
        `Check the username / password / domain for "${this.creds.domain}\\${this.creds.username}".`,
      );
    }
    return authed;
  }

  destroy(): void {
    for (const lane of this.lanes) {
      for (const agent of lane.agents.values()) agent.destroy();
      lane.agents.clear();
    }
  }
}

/**
 * Parse an HTTP `Retry-After` header (delta-seconds or an HTTP-date) into a
 * millisecond delay. Returns undefined when absent or unparseable.
 */
function parseRetryAfter(value: string | string[] | undefined): number | undefined {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - Date.now());
}

function mapNetworkError(err: NodeJS.ErrnoException, url: string): Error {
  if (err instanceof NetworkError || err instanceof AuthError) return err;
  const code = err.code ?? '';
  const hints: Record<string, string> = {
    ENOTFOUND: 'DNS lookup failed — check the host name and your network/VPN.',
    ECONNREFUSED: 'Connection refused — check the port and that the web application is running.',
    ETIMEDOUT: 'Connection timed out — check firewall rules and VPN connectivity.',
    CERT_HAS_EXPIRED: 'The TLS certificate has expired. Re-run with --insecure to bypass verification.',
    DEPTH_ZERO_SELF_SIGNED_CERT:
      'Self-signed TLS certificate. Re-run with --insecure to bypass verification (understand the risk).',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE:
      'TLS chain could not be verified. Re-run with --insecure to bypass verification.',
    ERR_TLS_CERT_ALTNAME_INVALID:
      'TLS certificate host name mismatch. Re-run with --insecure to bypass verification.',
  };
  const hint = hints[code];
  const mapped = new NetworkError(
    `Network error (${code || err.message}) reaching ${url}`,
    ...(hint === undefined ? [] : [hint]),
  );
  if (code) mapped.code = code;
  return mapped;
}
