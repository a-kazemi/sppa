# Security & data handling

This tool is built for security and compliance teams, so its own behaviour needs
to be boring and inspectable.

## Data handling guarantees

- **Read-only.** Every SharePoint call is an HTTP `GET`. There is no code path
  that issues `POST`/`MERGE`/`DELETE` or requests a form digest. It cannot
  change a permission, a group, or a document.
- **Single destination.** The only host contacted is the origin of the `--site`
  URL you pass. There is no update check, no analytics, no crash reporting, no
  license call — outbound or otherwise.
- **No telemetry.** The tool has no phone-home of any kind. Verify with a packet
  capture: traffic goes to your farm and nowhere else.
- **Nothing is written to disk** unless you redirect output yourself
  (`--format json > file`). No cache, no temp files, no log file.
- **Credentials** are read from `SPPERM_USERNAME` / `SPPERM_PASSWORD`
  (or flags) and held in memory only. They are never logged, never included in
  error messages, and never written anywhere. Passing `--password` triggers a
  warning because it is visible in the host's process list.

## What leaves your network

Nothing. This is a local CLI. Output is printed to your terminal (or a file you
choose). Sharing that output with anyone is your decision.

## Supply chain

- **Zero runtime dependencies.** `package.json` has no `dependencies`, only
  `typescript` and `@types/node` as dev dependencies. `npm install -g` pulls no
  transitive runtime packages.
- The NTLM handshake and MD4 are vendored in `src/auth/` rather than pulled from
  an unmaintained package, and are unit-tested against the [MS-NLMP] spec
  vectors.
- Published builds are the compiled contents of `src/`. You can diff `dist/`
  against source, or build from the tag yourself.

## Permissions the auditing account needs

- `explain-access`: *Read* on the site; the account must be able to enumerate
  site users and role assignments (any Read-level role can).
- `scan-site`: *Read* on the site. Items the account cannot see are skipped, not
  errored — run it as an account with broad read access for a complete picture.

The account never needs more than Read.

## Reporting a vulnerability

Open a GitHub issue for non-sensitive reports. For anything sensitive, use the
repository's private security advisory form
(`Security` → `Report a vulnerability`).
