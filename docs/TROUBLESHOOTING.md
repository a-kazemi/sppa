# Troubleshooting

Every failure in `sppa` prints one line to stderr:

```
error: <message>
<optional hint on a dim second line>
```

and exits with a stable code:

| Exit | Class | Meaning |
|------|-------|---------|
| `2` | usage | Bad flags / missing arguments |
| `3` | auth  | The NTLM handshake or `_api` authorisation failed |
| `4` | API   | SharePoint was reached and replied, but the request failed |
| `5` | network | DNS / TCP / TLS / timeout before a reply |

This page lists the exact message you will see, the cause, and the fix. Entries
are written so a maintainer can paste one straight into a GitHub issue reply.

The tool is **read-only** and sends only `GET` requests — nothing here can be
caused by `sppa` changing anything on the farm.

---

## Exit 3 — authentication

### `error: NTLM authentication was rejected (401 after handshake).`

Hint printed: `Check the username / password / domain for "<DOMAIN>\<user>".`

The three-leg NTLM handshake completed and SharePoint still answered `401`.

| Cause | Fix |
|-------|-----|
| Wrong password, or `--domain` / `SPPA_DOMAIN` does not match the account's NetBIOS domain. | Re-check all three. Use `DOMAIN\user` in `--username` so the domain cannot be ambiguous. |
| Account locked out or password expired. | Unlock / reset. A dedicated service account with a non-expiring password avoids repeat incidents. |
| The account has no rights **anywhere** on the web application, so SharePoint rejects it at the door rather than at `_api`. | Grant the account at least **Read** on the target site collection. |
| **Clock skew.** The NTLMv2 response embeds a timestamp; if the client clock is more than ~5 minutes off the DC, the response is refused and you get a 401 that looks exactly like a bad password. | Sync the client clock: `w32tm /resync` (Windows) or `sudo chronyc makestep` / `ntpdate` (Linux). Then retry. |
| **Extended Protection for Authentication (channel binding).** IIS is set to *Require* EPA. Because this client does not bind the NTLM token to the TLS channel, the token is rejected — but only over **HTTPS**. | Confirm by retrying against the same web application over **HTTP**: if HTTP works and HTTPS gives `401 after handshake`, it is EPA. Set EPA to *Allow* on the web application (`IIS → Authentication → Windows → Advanced Settings`), or file an issue asking for channel-binding support. |
| **NTLM reflection / LM compatibility level** locked down so NTLMv2 to the local machine name is refused. | Point `--site` at the load-balanced host name, not an individual WFE's own machine name. |

### `error: Server offered "<scheme>" but not NTLM.`

Hint printed: guidance to open an issue with your auth setup.

SharePoint answered `401` but the `WWW-Authenticate` header did **not** contain
`NTLM`. `<scheme>` is echoed verbatim — usually `Negotiate` or `Basic`.

| `<scheme>` | Cause | Fix |
|------------|-------|-----|
| `Negotiate` only | The web application is **Kerberos-only**, or it is **AD FS / WS-Federation** (the `Negotiate` is the redirect to an STS). | Enable NTLM as a fallback provider on the web application (`Windows Authentication → Providers → add NTLM`), point the tool at an NTLM-enabled zone/extension of the same web application, or open an issue for AD FS support. |
| `Basic` only | Basic auth over (hopefully) TLS; NTLM is disabled. | Enable the NTLM provider, or use an NTLM zone. Basic-only is not supported in v0.2.x. |
| `Negotiate, NTLM` but you still see this | You are hitting a proxy/WAF that strips the `NTLM` token from the header. | See **Proxy interference** below. |

### `error: Server did not return an NTLM Type 2 challenge.`

Hint printed: `Confirm NTLM is enabled for this web application and that the account is not locked out.`

The tool sent the Type 1 (NEGOTIATE) message and the reply to it had no
`WWW-Authenticate: NTLM <base64>` challenge.

| Cause | Fix |
|-------|-----|
| NTLM is half-configured: advertised on the first `401` but not actually serviced. | Re-check `Windows Authentication → Providers` on every WFE — they must match. |
| **Multiple WFEs without session affinity.** Leg 1 of the handshake lands on WFE-A, leg 2 on WFE-B, which has no in-flight handshake state. Symptom is *intermittent* — succeeds on retry. | Enable source-IP / cookie affinity on the load balancer, or point `--site` at a single WFE for the audit run. |
| A reverse proxy is not keeping the connection pinned (NTLM authenticates the TCP connection, not the request). | Configure the proxy for NTLM pass-through with connection affinity, or run `sppa` from inside the network with a direct route to the farm. |
| Account locked out between leg 1 and leg 3. | Unlock; retry. |

### `error: Not authorised for <url>`

No hint. This is a `401` on a specific `_api` URL **after** the connection
already authenticated — so credentials are fine, but this object is off-limits.

| Cause | Fix |
|-------|-----|
| The account can read the site but not this list/library/item. | Grant Read on the specific list, or accept the gap — `scan-site` silently skips what it cannot see, so partial results are still valid. |
| The `client.svc` / REST endpoint is disabled for the account by a **Web Application Policy** deny, or by `Set-SPWOPIBinding`-style lockdown. | Remove the deny for the service account, or run against a zone without it. |
| **Request Management** on the farm has a routing/throttling rule that denies `/_api/` for non-interactive user agents. | Add an allow rule for the `sppa` user agent, or run the audit from a machine/zone the rule does not cover. |

---

## Exit 4 — API

### `error: SharePoint returned a non-JSON response for <url>`

Hint printed: `The URL may be a sign-in page (auth misconfiguration) rather than the API.`

The request returned `200`, but the body was HTML, not JSON.

| Cause | Fix |
|-------|-----|
| The connection was silently redirected to a **sign-in page** (AD FS / FBA / a portal). NTLM "succeeded" against the proxy, not SharePoint. | Fix auth so `/_api/web` returns JSON in a browser with the same account. If the farm is federated, this tool cannot audit it in v0.2.x. |
| `--site` points at a **path that is not a SharePoint web** (e.g. a vanity URL handled by IIS directly, or `/_layouts/`). | Use the site collection or sub-web root, e.g. `https://sp/sites/hr`. |
| A **proxy error page** (502/504 rendered as HTML with a 200 by the proxy). | See **Proxy interference** below. |

### `error: Not found: <url>`

Hint printed: `Check the --site URL and object name.`

A clean `404` from SharePoint.

| Cause | Fix |
|-------|-----|
| Wrong `--site` — misspelled managed path, missing `/sites/`, or a web that has been deleted. | Open `<site>/_api/web` in a browser to confirm the base URL. |
| `explain-access --list "<title>"` / `scan-site` — the **list title** does not exist (titles are localised and can differ from the URL segment). | Use the exact display title as shown in *Site Contents*. |

### `error: SharePoint returned HTTP <status> for <url>`

Hint printed: the first ~400 characters of the response body.

Any other `>= 400` status. Common ones:

| Status | Cause | Fix |
|--------|-------|-----|
| `403` | Authenticated, but denied by policy/permission on this exact call (often `getUserEffectivePermissions` when the account lacks *Enumerate Permissions*). | Grant the service account **Full Read** at web-application policy level, or *Enumerate Permissions* on the site. |
| `429` / `503` with a `Retry-After` | Farm **throttling** (`Set-SPFarmConfig -RequestThrottling`, or a Request Management rule). Large libraries trigger this. | The client now retries these automatically — up to 3 times, honouring `Retry-After`, with exponential backoff. If the error still surfaces the farm stayed throttled through every retry: re-run with `--skip-items`, lower `--max-items`, or run off-peak. |
| `500` with `Microsoft.SharePoint.Client...` in the snippet | A server-side error in the `_api` call — often a corrupt role assignment or an orphaned principal the CSOM layer chokes on. | Note the list/item from `<url>`, fix or remove the bad ACL in the site, re-run. Please attach the snippet to an issue. |
| `400` on an OData query | A `$filter` / `$select` the farm's SharePoint build does not accept (older CU). | File an issue with your exact SharePoint build number (`Central Admin → Servers in Farm`). |

---

## Exit 5 — network

### `error: Network error (ENOTFOUND) reaching <url>`

Hint printed: `DNS lookup failed — check the host name and your network/VPN.`

The host name did not resolve. Check spelling, that you are on the corporate
network / VPN, and that split-DNS is giving you the internal record.

### `error: Network error (ECONNREFUSED) reaching <url>`

Hint printed: `Connection refused — check the port and that the web application is running.`

DNS resolved but nothing accepted the TCP connection.

| Cause | Fix |
|-------|-----|
| Wrong scheme — the web application is HTTPS only and `--site` used `http://` (or vice-versa). | Match the scheme. |
| Non-default port not included in `--site`. | Add it, e.g. `https://sp:44300/sites/hr`. |
| The IIS site / app pool is stopped. | Start it. |

### `error: Network error (ETIMEDOUT) reaching <url>`

Hint printed: `Connection timed out — check firewall rules and VPN connectivity.`

The SYN got no response. Almost always a **firewall** between you and the farm,
or a VPN that routes the subnet but not this host.

### `error: Request timed out after <n>ms: <url>`

The connection opened but SharePoint did not finish the response within the
per-request timeout (default 30000 ms).

| Cause | Fix |
|-------|-----|
| Very large `roleassignments` / `items` payload on a slow farm. | Raise the timeout: `--timeout 120000`. For `scan-site`, also add `--skip-items` or lower `--max-items`. |
| Farm under load / mid-crawl. | Run off-peak. |

### `error: Network error (DEPTH_ZERO_SELF_SIGNED_CERT) reaching <url>`

Also: `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `CERT_HAS_EXPIRED`,
`ERR_TLS_CERT_ALTNAME_INVALID`, `SELF_SIGNED_CERT_IN_CHAIN`.

Hint printed: names the cause and suggests `--insecure`.

Internal farms usually use a private CA or a self-signed certificate.

| Fix | Notes |
|-----|-------|
| **Preferred:** `export NODE_EXTRA_CA_CERTS=/path/to/internal-root-ca.pem` and re-run. | Keeps certificate verification on. |
| `sppa ... --insecure` | Disables verification for the run. You lose protection against a man-in-the-middle — only on a trusted network. |
| `ERR_TLS_CERT_ALTNAME_INVALID` specifically | The certificate is valid but does not list the host name you used. Use the host name in the certificate's SAN, or `--insecure`. |

---

## Conditions with no dedicated message

### Proxy interference

`sppa` v0.2.x does **not** read `HTTP_PROXY` / `HTTPS_PROXY` and always
connects directly. A corporate proxy in the path shows up as one of:

- `Network error (ECONNREFUSED / ETIMEDOUT)` — direct route is blocked, proxy required.
- `SharePoint returned a non-JSON response` — proxy served its own auth or error page.
- A TLS error naming the **proxy's** certificate, not SharePoint's.
- `Server did not return an NTLM Type 2 challenge` — proxy broke connection pinning.

Fix: run `sppa` from a host with a **direct** network route to the farm (a
jump box inside the datacentre network). Proxy support may be added on request.

### The `401` loop / handshake never terminates

If a run hangs or every call fails at leg 2/3 despite correct credentials, the
usual causes are, in order: (1) load balancer without affinity across WFEs,
(2) a proxy not pinning the keep-alive socket, (3) EPA/channel binding on HTTPS
(see *Exit 3*), (4) clock skew. Isolate by pointing `--site` at a single WFE
over HTTP with a known-good account; add one variable back at a time.

### Empty or partial `scan-site` results

Not an error. `scan-site` **silently skips** any object the account cannot read.
If a site you expect to see is missing, the service account lacks Read there —
grant it and re-run. Item-level unique-permission results require the account to
be able to open the items; anything hidden from it is omitted with no message.

---

## Filing a good issue

Include:

1. The **exact** `error:` line and the hint line.
2. SharePoint build number (`Central Administration → Servers in Farm`).
3. Auth setup: NTLM / Kerberos / AD FS / FBA, HTTP or HTTPS, single WFE or load-balanced, any reverse proxy.
4. Whether the same account and URL work in a browser for `<site>/_api/web`.
5. `node --version` and how you installed the tool.

Never paste credentials, tokens, or full `--format json` output from a real
farm into a public issue.
