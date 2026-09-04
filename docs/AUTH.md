# Authentication

## What v0.2.x supports

**NTLM with explicit credentials, over HTTP or HTTPS.** That is the whole
surface. The handshake is implemented in `src/auth/` and does not depend on any
third-party NTLM/SharePoint auth library.

The client:

1. Sends the request and, on `401` with `WWW-Authenticate: NTLM`, begins the
   handshake.
2. Sends a Type 1 (NEGOTIATE) message.
3. Parses the Type 2 (CHALLENGE) message, including the TargetInfo block.
4. Sends a Type 3 (AUTHENTICATE) message with an **NTLMv2** response and an
   LMv2 response.

All four legs of one request travel over a single pinned keep-alive socket,
because NTLM authenticates the TCP connection rather than the individual request.
The socket stays authenticated, so later requests on it skip the handshake.
`--concurrency <n>` opens `n` such sockets, each with its own handshake, and
serves one request per socket at a time so legs never interleave; it defaults to
`1` (fully serial) and is worth raising for `scan-site` on a large site.

On a `429` / `503` the client backs off and retries (honouring `Retry-After`),
up to 3 times, re-running the handshake on a fresh socket each time. Transient
socket errors (`ECONNRESET`, `ETIMEDOUT`, …) are retried the same way.

## Supplying credentials

Preferred — environment variables (not visible in the process list). Set them
in the same shell you run `sppa` from; they last only for that session.

**macOS / Linux (bash, zsh):**

```bash
export SPPA_USERNAME='CONTOSO\svc_audit'   # DOMAIN\user, or plain user + --domain
export SPPA_PASSWORD='...'
export SPPA_DOMAIN='CONTOSO'               # optional if DOMAIN\user is used
```

**Windows — PowerShell:**

```powershell
$env:SPPA_USERNAME = 'CONTOSO\svc_audit'   # DOMAIN\user, or plain user + --domain
$env:SPPA_PASSWORD = '...'
$env:SPPA_DOMAIN   = 'CONTOSO'             # optional if DOMAIN\user is used
```

**Windows — Command Prompt (cmd.exe):**

```bat
set SPPA_USERNAME=CONTOSO\svc_audit
set SPPA_PASSWORD=...
set SPPA_DOMAIN=CONTOSO
```

Note for cmd.exe: do **not** quote the values — `set X='y'` makes the quotes
part of the value. `export` is a Unix command and does not exist in cmd.exe or
PowerShell.

Fallback — flags (`--username`, `--password`, `--domain`). Using `--password`
prints a warning; avoid it on shared hosts.

The domain is resolved in this order: `--domain` → `SPPA_DOMAIN` → the
`DOMAIN\` prefix of the username → empty.

## Which account to use

A **dedicated read-only service account** is recommended:

- It needs at least *Read* on the site collection you point it at.
- For `scan-site` item-level results it needs to be able to see items with unique
  permissions; anything it cannot see is silently skipped (no error).
- It never needs write access. The tool only issues `GET` requests.

## Not supported (open an issue if you need it)

| Mechanism | Status |
|-----------|--------|
| AD FS / WS-Federation (`WWW-Authenticate: Negotiate` to an STS, `FedAuth` cookie) | Not implemented. The tool detects it and prints guidance. |
| Forms-Based Auth (FBA) | Not implemented. |
| Kerberos-only endpoints (`Negotiate` without NTLM fallback) | Not implemented — no pure-JS Kerberos. Enable NTLM fallback on the web application, or open an issue. |
| Client-certificate auth | Not implemented. |
| MFA on the sign-in path | Not supported. |

These are deliberately out of scope for the first release. AD FS and FBA are
much larger handshakes with per-environment variation; they will only be added
if real users ask for them.

## TLS

Internal farms frequently use a private CA or a self-signed certificate. If
certificate verification fails you will get a clear error naming the cause. To
bypass verification (understand the risk — you lose protection against a
man-in-the-middle):

```bash
sppa scan-site --site https://sharepoint/sites/hr --insecure
```

A cleaner alternative is to trust your internal CA for Node:

```bash
# macOS / Linux
export NODE_EXTRA_CA_CERTS=/path/to/internal-root-ca.pem
```

```powershell
# Windows — PowerShell
$env:NODE_EXTRA_CA_CERTS = 'C:\path\to\internal-root-ca.pem'
```

```bat
REM Windows — Command Prompt
set NODE_EXTRA_CA_CERTS=C:\path\to\internal-root-ca.pem
```

## Troubleshooting

Full catalogue — every `error:` string with cause and fix, plus conditions that
have no dedicated message (clock skew, channel binding / Extended Protection,
`_api` disabled, reverse proxies, multi-WFE affinity) — is in
[TROUBLESHOOTING.md](TROUBLESHOOTING.md). Quick reference:

| Symptom | Likely cause |
|---------|--------------|
| `error: NTLM authentication was rejected (401 after handshake).` | Wrong username / password / domain, or the account is locked out. |
| `Server offered "Negotiate" but not NTLM.` | The web application uses Kerberos-only or AD FS. See the table above. |
| `SharePoint returned a non-JSON response` | The URL redirected to a sign-in page — usually AD FS/FBA, or the wrong `--site`. |
| `Network error (DEPTH_ZERO_SELF_SIGNED_CERT)` | Self-signed TLS cert. Use `NODE_EXTRA_CA_CERTS` or `--insecure`. |
