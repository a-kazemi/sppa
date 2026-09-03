# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `sample/` — a synthetic SharePoint Server 2019 site collection: recorded `_api`
  fixtures plus the exact `scan-site` / `explain-access` output produced from
  them, covering every finding type. `test/sample.test.ts` drives the real
  parse → analyse → render pipeline against it (no live farm, no production code
  change) and fails if the committed output drifts. Regression harness for the
  pre-mortem's `_api`-shape risk (F4); the NTLM handshake still needs a real farm.

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
