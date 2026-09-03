/**
 * HTTP(S) client that performs the NTLM handshake on a pinned keep-alive socket.
 *
 * NTLM authenticates the TCP connection, not the individual request, so all
 * three legs of the handshake (negotiate -> challenge -> authenticate) plus the
 * final authenticated request must travel over the same socket. We enforce that
 * with a per-origin Agent limited to a single socket, and by always draining
 * response bodies so the socket returns cleanly to the keep-alive pool.
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
}

interface RawRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Buffer;
}

export class NtlmHttpClient {
  private readonly creds: Required<Credentials>;
  private readonly insecure: boolean;
  private readonly timeoutMs: number;
  private readonly agents = new Map<string, http.Agent | https.Agent>();

  constructor(opts: NtlmHttpClientOptions) {
    this.creds = {
      username: opts.credentials.username,
      password: opts.credentials.password,
      domain: opts.credentials.domain,
      workstation: opts.credentials.workstation || 'WORKSTATION',
    };
    this.insecure = Boolean(opts.insecure);
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }

  private agentFor(u: URL): http.Agent | https.Agent {
    const key = `${u.protocol}//${u.host}`;
    let agent = this.agents.get(key);
    if (!agent) {
      const common = { keepAlive: true, maxSockets: 1, maxFreeSockets: 1 };
      agent =
        u.protocol === 'https:'
          ? new https.Agent({ ...common, rejectUnauthorized: !this.insecure })
          : new http.Agent(common);
      this.agents.set(key, agent);
    }
    return agent;
  }

  private rawRequest(opts: RawRequestOptions): Promise<HttpResponse> {
    const u = new URL(opts.url);
    const transport = u.protocol === 'https:' ? https : http;
    const agent = this.agentFor(u);

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
        req.destroy(new NetworkError(`Request timed out after ${this.timeoutMs}ms: ${opts.url}`));
      });
      req.on('error', (err: NodeJS.ErrnoException) => reject(mapNetworkError(err, opts.url)));
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  /** Issue an NTLM-authenticated request, running the handshake if challenged. */
  async request(opts: RawRequestOptions): Promise<HttpResponse> {
    const first = await this.rawRequest(opts);
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
    const challenge = await this.rawRequest({
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

    const authed = await this.rawRequest({
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
    for (const agent of this.agents.values()) agent.destroy();
    this.agents.clear();
  }
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
  return new NetworkError(
    `Network error (${code || err.message}) reaching ${url}`,
    ...(hint === undefined ? [] : [hint]),
  );
}
