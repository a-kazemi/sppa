# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Automatic retry in the HTTP layer for server throttling (`429` / `503`,
  honouring `Retry-After` — delta-seconds or HTTP-date) and transient socket
  errors (`ECONNRESET` / `ETIMEDOUT` / `EPIPE` / …). Full-jitter exponential
  backoff, 3 attempts by default, each capped at 60s; the whole NTLM handshake is
  re-run on a fresh socket for every retry. Tunable via new
  `NtlmHttpClient` options (`retries`, `retryBaseMs`, `maxRetryDelayMs`). Covered
  by `test/httpClient.test.ts`, which also proves the three-leg handshake wiring
  against a localhost server for the first time.
- `list-access` — the inverse of `explain-access`: enumerate every principal
  that has access to a web or list and how. SharePoint groups are expanded to
  their members (each tagged with the group it came through); AD security groups
  and broad-audience claims are reported as single unexpandable entries, with a
  note, since REST cannot expand them. `--list <title>` scopes it to one list and
  reports when that list inherits from the web. `--format json` emits the
  standard envelope (`command: "list-access"`). Pure logic in
  `src/analysis/listAccess.ts`, covered by `test/listAccess.test.ts` and a
  `sample/list-access.{json,txt}` worked example pinned by `test/sample.test.ts`.
- `scan-site --recurse` — walk subwebs (`web/webs`) breadth-first (bounded at 500
  webs) and merge every web's findings into one report. Each finding carries an
  optional `web` field (server-relative URL) so you can see which subweb it came
  from, and the summary gains `websScanned`. A non-recursive scan is byte-for-byte
  unchanged. `mergeScanReports()` in `src/analysis/scanSite.ts`, covered by
  `test/scanSite.test.ts`.

## [0.1.1] — 2026-09-03

### Changed

- Finished the `spperm` -> `sppa` rename: the JSON envelope `tool` field is now
  `"sppa"` (was `"sp-permission-analyzer"`, which contradicted the documented
  `schemaVersion: 1` contract), along with the `--help` banner, the HTTP
  `User-Agent`, the committed `sample/*.json`, `LICENSE` (`Auto Company` ->
  `Amir Kazemi`), the `package.json` metadata, and every GitHub URL in the docs
  and issue templates.
- The CLI version is now read at runtime from `package.json` rather than being
  duplicated in `src/version.ts`, so a release bump only touches one file.

### Added

- `docs/TROUBLESHOOTING.md` — every `error:` string the CLI can print, with its
  cause and fix, written to be pasted straight into an issue-tracker reply. Also
  covers conditions that surface as a generic error: clock skew, channel binding
  / Extended Protection for Authentication, `_api` disabled by policy, reverse
  proxies, and multi-WFE affinity. `test/errors.test.ts` pins the exit-code
  contract and asserts the code paths still emit the exact strings the doc
  documents (no live farm — `_api` errors via the client seam, the NTLM
  handshake against a throwaway localhost server).
- `sample/` — a synthetic SharePoint Server 2019 site collection: recorded `_api`
  fixtures plus the exact `scan-site` / `explain-access` output produced from
  them, covering every finding type. `test/sample.test.ts` drives the real
  parse → analyse → render pipeline against it (no live farm, no production code
  change) and fails if the committed output drifts. Regression harness for the
  pre-mortem's `_api`-shape risk (F4); the NTLM handshake still needs a real farm.
- `sample/explain-access-deny.{json,txt}` — a second `explain-access` worked
  example scoped to a single list (`--list Salaries`) that resolves to
  `NO ACCESS`, showing how a DENY verdict renders and how an unexpandable AD
  security group on the ACL is still surfaced (marked uncertain) while the empty
  effective-permission mask stays authoritative. Pinned by `test/sample.test.ts`.
- `CONTRIBUTING.md` and GitHub issue forms (`.github/ISSUE_TEMPLATE/`) — a bug
  report, a dedicated authentication-failure report mirroring the
  `docs/TROUBLESHOOTING.md § Exit 3` checklist, and a "free permission audit /
  share a result" intake — plus a pull-request template. `CONTRIBUTING.md`
  states the `v0.1.x` feature freeze so out-of-scope PRs are not wasted work.
  Docs/infra only; no code or CLI change.

## [0.1.0] — 2026-09-03

Initial public release.

### Added

- `explain-access` — trace why a user does or does not have access to a site or
  list: effective permissions, direct grants, SharePoint group membership,
  broad-audience claims, AD security groups on the ACL, and where inheritance
  breaks along the path.
- `scan-site` — single site collection audit: broken permission inheritance
  (web / list / item), orphaned SID principals with confidence scoring,
  broad-audience grants, oversized SharePoint groups, and site collection
  administrators.
- `--format json` with a versioned envelope (`schemaVersion: 1`) for both
  commands.
- Vendored NTLMv2 handshake (explicit credentials) over a pinned keep-alive
  socket, verified against the [MS-NLMP] 4.2.4 test vectors.
- Read-only by construction — the tool issues only `GET` requests.
