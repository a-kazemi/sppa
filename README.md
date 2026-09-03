# sppa

[![CI](https://github.com/a-kazemi/sppa/actions/workflows/ci.yml/badge.svg)](https://github.com/a-kazemi/sppa/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Explain and audit **SharePoint Server on-premises** permissions from the command
line. Built for SharePoint Server 2016, 2019 and Subscription Edition farms.

- **`explain-access`** — answer "why does this user have access to this site?"
  in one command: direct grants, SharePoint group membership, broad-audience
  claims ("Everyone"), AD security groups, and exactly where inheritance breaks.
- **`list-access`** — the inverse: "who has access to this site or list, and
  how?" SharePoint groups are expanded to their members; AD security groups and
  broad audiences are flagged as unexpandable.
- **`scan-site`** — audit one site collection (add `--recurse` for subwebs) for
  broken permission inheritance, orphaned SIDs (deleted AD accounts still on
  ACLs), broad-audience grants, oversized SharePoint groups, and site collection
  administrators.

**Read-only. No data leaves your machine. No telemetry. No account required.**
The tool only issues `GET` requests to the SharePoint REST API (`_api`).

> Status: `v0.1.1`, early release. It does one job on classic NTLM farms. If it
> is useful — or if it breaks in your environment — please
> [open an issue](https://github.com/a-kazemi/sppa/issues).

---

## Install

Requires **Node.js 18 or newer**. Not on npm yet — install from source:

```bash
git clone https://github.com/a-kazemi/sppa.git
cd sppa
npm install && npm run build
npm link            # puts `sppa` on your PATH

sppa --help
```

Or install straight from GitHub:

```bash
npm install -g github:a-kazemi/sppa
```

## Authentication

The `v0.1.x` line supports **NTLM with explicit credentials only** (see [docs/AUTH.md](docs/AUTH.md);
auth failures are catalogued in [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)).
Provide the auditing account through environment variables — never on the command
line, where it would show up in the process list:

```bash
export SPPA_USERNAME='CONTOSO\svc_audit'
export SPPA_PASSWORD='...'
# optional; also parsed from DOMAIN\user above
export SPPA_DOMAIN='CONTOSO'
```

A read-only account works for everything except item-level scanning inside lists
where it lacks access — those items are simply skipped.

## Usage

### Explain why a user has access

```bash
sppa explain-access --site https://sharepoint/sites/hr --user 'CONTOSO\jdoe'
```

```
SharePoint access explanation
Site: https://sharepoint/sites/hr
User: Jane Doe (User, id 14)
Login: i:0#.w|contoso\jdoe

Verdict: HAS ACCESS

Effective permissions on this scope:
  • Open the site
  • View pages
  • View list items / documents
  • Edit list items

Inheritance is broken at:
  • list: Salary Review

How access is granted:
  ✓ SharePoint group "HR Site Members" — Contribute @ list "Salary Review"

Notes:
  • 1 AD security group(s) on this scope could not be expanded via REST.
    The effective-permission check above is still authoritative.
```

Scope it to a single list, or handle classic Windows-claims logins:

```bash
sppa explain-access --site https://sharepoint/sites/hr \
  --user 'CONTOSO\jdoe' --list 'Salary Review' --windows-claims
```

### List who has access

```bash
sppa list-access --site https://sharepoint/sites/hr
sppa list-access --site https://sharepoint/sites/hr --list 'Salary Review'
```

`list-access` reads the role assignments on the scope (or the parent it inherits
from), expands every SharePoint group to its members, and reports AD security
groups and broad audiences ("Everyone") as single entries it cannot expand. See
[`sample/list-access.txt`](sample/list-access.txt) for the shape of the output.

### Audit a site collection

```bash
sppa scan-site --site https://sharepoint/sites/hr
sppa scan-site --site https://sharepoint/sites/hr --recurse
sppa scan-site --site https://sharepoint/sites/hr --format json > hr-audit.json
```

`scan-site` walks the web, every visible list, and (unless `--skip-items`) list
items with unique permissions. Add `--recurse` to walk subwebs too — every
finding is then tagged with the subweb it came from and the summary reports how
many webs were scanned. Use `--max-items` to bound very large libraries and
`--large-group-threshold` to tune the oversized-group flag.

## Worked example

Not ready to point it at a real farm yet? [`sample/`](sample/) contains a
synthetic SharePoint Server 2019 site collection — recorded `_api` responses plus
the exact `scan-site` and `explain-access` output the tool produces from them,
showing every finding (broken inheritance at web/list/item, an orphaned SID, an
`Everyone` grant, an unexpandable AD group, an oversized group, a site collection
admin). It also has both an **ALLOW** trace (`explain-access.txt`) and a **DENY**
trace scoped to a single list (`explain-access-deny.txt`). A test regenerates it
from the fixtures on every run, so it never drifts from the code.

For a line-by-line walk through that sample output — the ALLOW trace, the DENY
trace, and `scan-site` — see [docs/GUIDE-explain-access.md](docs/GUIDE-explain-access.md).

## JSON output

Both commands accept `--format json` and emit a stable envelope
(`schemaVersion: 1`) suitable for diffing between runs or feeding into a report:

```json
{
  "tool": "sppa",
  "schemaVersion": 1,
  "command": "scan-site",
  "generatedAt": "2026-09-03T12:00:00.000Z",
  "site": "https://sharepoint/sites/hr",
  "result": { "summary": { "...": "..." }, "brokenInheritance": [] }
}
```

## What it does **not** do (yet)

- No AD FS / WS-Federation or Forms-Based Auth (NTLM only).
- No Kerberos-only endpoints.
- No AD security-group expansion — SharePoint REST does not expose it. The tool
  reports which AD groups are on each ACL and relies on
  `getUserEffectivePermissions` (which resolves them server-side) for the verdict.
- No writes, ever. It will not fix anything it finds.
- No multi-farm, scheduled snapshots, or drift diffing.

## Exit codes

| Code | Meaning |
|-----:|---------|
| 0 | Success |
| 2 | Usage error (bad flags / missing arguments) |
| 3 | Authentication failed |
| 4 | SharePoint reachable but the request failed |
| 5 | Network / TLS / DNS failure |

Every non-zero exit prints one `error:` line and usually a hint.
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) lists each message with its
cause and fix — including cases with no dedicated message (clock skew, channel
binding / Extended Protection, `_api` disabled, reverse proxies, multi-WFE
affinity).

## Security

See [docs/SECURITY.md](docs/SECURITY.md). Short version: read-only, single farm,
no outbound connections other than to the `--site` you pass, credentials read
from the environment and never logged.

## Feedback wanted — and a free permission audit

This is an early release and the fastest way to make it better is to hear from
people running real farms.

- **Hit a bug or an auth failure?** [Open an issue](https://github.com/a-kazemi/sppa/issues/new/choose)
  with your SharePoint version and the (redacted) error — the
  *Authentication failure report* form is the one we most want filled in right now.
- **Have a messy permission situation you'd like a second pair of eyes on?**
  Use the [*free permission audit*](https://github.com/a-kazemi/sppa/issues/new/choose)
  form (no data required) and we'll help you read the `explain-access` /
  `scan-site` output and figure out what to fix — free, no strings. We're doing
  this to learn which problems matter most.

## Development

```bash
npm install
npm run build
npm test          # builds, then runs the node:test suite
```

The permission-analysis logic (`src/analysis/`) and the NTLM handshake
(`src/auth/`) are pure functions unit-tested against recorded REST fixtures and
the [MS-NLMP] test vectors — no live farm needed to hack on them.
`test/sample.test.ts` runs the whole `_api` → parse → analyse → render pipeline
against the synthetic farm in [`sample/`](sample/) and fails if the committed
output there goes stale.

See [CONTRIBUTING.md](CONTRIBUTING.md) for what is in and out of scope — `v0.1.x`
is feature-frozen; bug fixes, docs, tests, and auth reports are what move it
forward.

## License

MIT 
